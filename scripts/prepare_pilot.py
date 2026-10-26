#!/usr/bin/env python3
"""Build the Flushing pilot dataset for Rest Route.

Run once on a computer with internet access (from the repository root):

    python scripts/prepare_pilot.py

What it does
------------
1. Reads the pilot area from data/pilot_area.json and makes a larger
   routing area (service area + buffer) so trips near the edge can detour.
2. Downloads the OpenStreetMap walking network for the routing area with
   OSMnx (stairs and private paths excluded), projects it to UTM 18N and
   converts it to Rest Route segments.
3. Downloads OSM seating features and NYC DOT "Seating Locations"
   (dataset esmy-s8q5) for the routing area.
4. Applies field checks (data/field_checks.csv), eligibility rules,
   cautious de-duplication and walkway attachment.
5. Precomputes seat-to-seat walking distances.
6. Writes versioned artifacts to data/pilot/ and a manifest copy to
   data/manifests/.

Offline / repeatable options
----------------------------
--osm-graphml FILE      reuse a saved OSM walk graph (raw/osm_walk.graphml)
--osm-seats-geojson F   reuse saved OSM seating features
--dot-csv FILE          use a CSV exported from the NYC Open Data page
--dot-json FILE         use a saved JSON response from the SODA API
--skip-dot              build without NYC DOT seating (recorded in manifest)

The server never downloads anything; it only reads these artifacts.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.data.build import (  # noqa: E402
    attach_seats,
    dumps_compact,
    graph_fingerprint,
    graph_from_json,
    graph_to_json,
    now_iso,
    seat_distance_matrix,
)
from app.data.seats import RULES, rules_hash  # noqa: E402
from app.data.sources import (  # noqa: E402
    NYC_DOT_METADATA_URL,
    NYC_DOT_SEATING_PAGE,
    NYC_DOT_SODA_URL,
    WALK_FILTER,
    apply_field_checks,
    dot_row_to_seat,
    osm_feature_to_seat,
    osmnx_to_pedgraph,
)

UTM_CRS = "EPSG:32618"
MAX_ELIGIBLE_SEATS = 3000
USER_AGENT = "RestRoute-student-project/0.1 (Congressional App Challenge; contact via repository)"

OSM_SEAT_TAGS = {"amenity": ["bench", "shelter"], "highway": ["bus_stop"]}
OSM_PLACE_TAGS = {
    "amenity": [
        "library", "hospital", "clinic", "doctors", "pharmacy", "place_of_worship", "community_centre",
        "social_facility", "post_office", "townhall", "bank", "marketplace", "bus_station",
    ],
    "railway": ["station"],
    "leisure": ["park"],
    "shop": ["supermarket", "mall", "department_store"],
}


def log(msg: str) -> None:
    print(f"[prepare] {msg}", flush=True)


def load_area(path: Path):
    from pyproj import Transformer
    from shapely.geometry import Polygon, mapping
    from shapely.ops import transform

    area = json.loads(path.read_text())
    service_ll = Polygon(area["service_polygon_lonlat"])
    to_utm = Transformer.from_crs("EPSG:4326", UTM_CRS, always_xy=True).transform
    to_ll = Transformer.from_crs(UTM_CRS, "EPSG:4326", always_xy=True).transform
    routing_utm = transform(to_utm, service_ll).buffer(area["routing_buffer_m"], join_style="mitre")
    routing_ll = transform(to_ll, routing_utm)
    return area, service_ll, routing_ll, [list(c) for c in mapping(routing_ll)["coordinates"][0]]


def fetch_graph(routing_ll, out_raw: Path, graphml: Path | None):
    import osmnx as ox

    if graphml:
        log(f"loading saved walk graph {graphml}")
        return ox.load_graphml(graphml), f"saved file {graphml.name}"
    ox.settings.useful_tags_way = list(
        dict.fromkeys(list(ox.settings.useful_tags_way) + ["access", "foot", "oneway:foot", "footway", "surface", "incline", "wheelchair", "crossing"])
    )
    ox.settings.http_user_agent = USER_AGENT
    log("downloading OSM walking network (Overpass via OSMnx)…")
    G = ox.graph_from_polygon(
        routing_ll, network_type="walk", custom_filter=WALK_FILTER, simplify=True, retain_all=True, truncate_by_edge=True
    )
    out_raw.mkdir(parents=True, exist_ok=True)
    ox.save_graphml(G, out_raw / "osm_walk.graphml")
    return G, f"Overpass API via OSMnx {ox.__version__}"


def fetch_osm_features(polygon_ll, tags, saved: Path | None, out_file: Path):
    import geopandas as gpd
    import osmnx as ox

    if saved:
        return gpd.read_file(saved)
    try:
        gdf = ox.features_from_polygon(polygon_ll, tags=tags)
    except ox._errors.InsufficientResponseError:
        log(f"no OSM features found for {sorted(tags)}; continuing with none")
        return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs="EPSG:4326")
    gdf = gdf.reset_index()
    # drop list/dict columns (way node lists, relation members) so the file can be saved
    keep = [c for c in gdf.columns if c == "geometry" or not gdf[c].apply(lambda v: isinstance(v, (list, dict))).any()]
    gdf = gdf[keep]
    out_file.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out_file, driver="GeoJSON")
    return gdf


def osm_seats_from_gdf(gdf, imported_at):
    seats = []
    for _, row in gdf.iterrows():
        element = row.get("element") or row.get("element_type") or "node"
        osm_id = row.get("id") if "id" in row else row.get("osmid")
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        pt = geom if geom.geom_type == "Point" else geom.representative_point()
        tags = {k: v for k, v in row.items() if k not in {"geometry", "element", "element_type", "id", "osmid"}}
        s = osm_feature_to_seat(str(element), osm_id, tags, pt.x, pt.y, geom.geom_type, imported_at)
        if s:
            seats.append(s)
    return seats


def fetch_dot(routing_ll, args, imported_at, raw_dir: Path):
    import requests

    minx, miny, maxx, maxy = routing_ll.bounds
    source_updated = None
    if args.skip_dot:
        return [], "skipped (--skip-dot)", None
    if args.dot_csv:
        with open(args.dot_csv, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        how = f"CSV export {Path(args.dot_csv).name}"
    elif args.dot_json:
        rows = json.loads(Path(args.dot_json).read_text())
        how = f"saved JSON {Path(args.dot_json).name}"
    else:
        log("downloading NYC DOT Seating Locations (SODA API)…")
        params = {
            "$where": f"within_box(the_geom, {maxy}, {minx}, {miny}, {maxx})",
            "$limit": "50000",
        }
        r = requests.get(NYC_DOT_SODA_URL, params=params, timeout=60, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        rows = r.json()
        how = f"SODA API {NYC_DOT_SODA_URL}"
        try:
            meta = requests.get(NYC_DOT_METADATA_URL, timeout=30, headers={"User-Agent": USER_AGENT}).json()
            ts = meta.get("rowsUpdatedAt")
            if ts:
                source_updated = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts)))
        except Exception as e:  # noqa: BLE001
            log(f"could not read dataset metadata ({e}); source_updated_at left empty")
        raw_dir.mkdir(parents=True, exist_ok=True)
        (raw_dir / "nyc_dot_seating.json").write_text(json.dumps(rows))
    from shapely.geometry import Point

    seats = []
    for row in rows:
        s = dot_row_to_seat(row, imported_at, source_updated)
        if s and routing_ll.covers(Point(s.lon, s.lat)):
            seats.append(s)
    return seats, how, source_updated


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--area", type=Path, default=REPO / "data" / "pilot_area.json")
    ap.add_argument("--out", type=Path, default=REPO / "data" / "pilot")
    ap.add_argument("--osm-graphml", type=Path)
    ap.add_argument("--osm-seats-geojson", type=Path)
    ap.add_argument("--osm-places-geojson", type=Path)
    ap.add_argument("--dot-csv", type=Path)
    ap.add_argument("--dot-json", type=Path)
    ap.add_argument("--skip-dot", action="store_true")
    ap.add_argument("--field-checks", type=Path, default=REPO / "data" / "field_checks.csv")
    ap.add_argument("--curated-attachments", type=Path, default=REPO / "data" / "curated_attachments.json")
    ap.add_argument("--curated-places", type=Path, default=REPO / "data" / "curated_places.json")
    ap.add_argument("--trips", type=Path, default=REPO / "data" / "pilot_trips.json")
    ap.add_argument("--manifests-dir", type=Path, default=REPO / "data" / "manifests")
    args = ap.parse_args()

    t_start = time.perf_counter()
    timings = {}
    imported_at = now_iso()
    warnings: list[str] = []
    out: Path = args.out
    work = out.with_name(out.name + ".tmp")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    area, service_ll, routing_ll, routing_ring = load_area(args.area)
    log(f"area: {area['name']}")

    # 1. walking network
    t = time.perf_counter()
    G, graph_how = fetch_graph(routing_ll, work / "raw", args.osm_graphml)
    import osmnx as ox

    Gp = ox.project_graph(G, to_crs=UTM_CRS)
    graph, w = osmnx_to_pedgraph(Gp, UTM_CRS)
    warnings += w
    timings["walk_graph_s"] = round(time.perf_counter() - t, 1)
    log(f"walk graph: {len(graph.nodes)} nodes, {len(graph.segments)} segments")

    # 2. seats
    t = time.perf_counter()
    osm_gdf = fetch_osm_features(routing_ll, OSM_SEAT_TAGS, args.osm_seats_geojson, work / "raw" / "osm_seats.geojson")
    osm_seats = osm_seats_from_gdf(osm_gdf, imported_at)
    dot_seats, dot_how, dot_updated = fetch_dot(routing_ll, args, imported_at, work / "raw")
    seats = osm_seats + dot_seats
    log(f"seat records: {len(osm_seats)} OSM, {len(dot_seats)} NYC DOT")
    from pyproj import Transformer

    proj = Transformer.from_crs("EPSG:4326", UTM_CRS, always_xy=True)
    for s in seats:
        s.x, s.y = proj.transform(s.lon, s.lat)
    checks = []
    if args.field_checks.exists():
        with open(args.field_checks, newline="", encoding="utf-8-sig") as f:
            checks = list(csv.DictReader(f))
    warnings += apply_field_checks(seats, checks)
    curated = json.loads(args.curated_attachments.read_text()) if args.curated_attachments.exists() else {}
    curated = {k: v for k, v in curated.items() if not k.startswith("_")}
    built = attach_seats(graph, seats, curated_attachments=curated)
    warnings += built.warnings
    eligible = [s for s in built.seats.values() if s.routing_eligible]
    if len(eligible) > MAX_ELIGIBLE_SEATS:
        log(f"ERROR: {len(eligible)} eligible seats exceeds the supported maximum of {MAX_ELIGIBLE_SEATS}. Shrink the area.")
        return 2
    timings["seats_s"] = round(time.perf_counter() - t, 1)

    # 3. distance matrix
    t = time.perf_counter()
    gjson = graph_to_json(graph)
    graph_rt = graph_from_json(json.loads(json.dumps(gjson)))  # fingerprint what the server will load
    fp = graph_fingerprint(graph_rt)
    matrix = seat_distance_matrix(graph_rt, built.seat_node)
    timings["matrix_s"] = round(time.perf_counter() - t, 1)
    log(f"distance matrix for {len(eligible)} seats in {timings['matrix_s']} s")

    # 4. places
    places_gdf = fetch_osm_features(service_ll, OSM_PLACE_TAGS, args.osm_places_geojson, work / "raw" / "osm_places.geojson")
    places = []
    seen = set()
    for _, row in places_gdf.iterrows():
        name = row.get("name")
        if not isinstance(name, str) or not name.strip() or row.geometry is None:
            continue
        pt = row.geometry if row.geometry.geom_type == "Point" else row.geometry.representative_point()
        if not service_ll.covers(pt):
            continue
        k = (name.strip().lower(), round(pt.x, 4), round(pt.y, 4))
        if k in seen:
            continue
        seen.add(k)
        cat = next((str(row.get(c)) for c in ("amenity", "railway", "leisure", "shop") if isinstance(row.get(c), str)), None)
        el = row.get("element") or row.get("element_type") or "node"
        oid = row.get("id") if "id" in row else row.get("osmid")
        places.append({"id": f"osm-{el}-{oid}", "name": name.strip(), "category": cat, "lat": pt.y, "lon": pt.x, "source": "osm"})
    if args.curated_places.exists():
        for p in json.loads(args.curated_places.read_text()):
            places.append({**p, "source": "curated"})
    trips = []
    if args.trips.exists():
        for t_ in json.loads(args.trips.read_text()):
            def find(qs):
                for q in [qs] if isinstance(qs, str) else qs:
                    ql = q.lower()
                    hit = next((p for p in sorted(places, key=lambda p: p["name"]) if ql in p["name"].lower()), None)
                    if hit:
                        return hit
                return None

            a, b = find(t_["from_place"]), find(t_["to_place"])
            if a and b:
                trips.append({
                    "id": t_["id"], "name": t_["name"],
                    "from": {"name": a["name"], "lat": a["lat"], "lon": a["lon"]},
                    "to": {"name": b["name"], "lat": b["lat"], "lon": b["lon"]},
                    "suggested_limits_m": t_.get("suggested_limits_m", []),
                })
            else:
                warnings.append(f"saved trip {t_['id']!r} skipped: place not found in imported landmarks")

    # 5. write artifacts
    version = f"flushing-{imported_at[:10]}-{fp[:8]}-{rules_hash()}"
    (work / "graph.json.gz").write_bytes(gzip.compress(dumps_compact(gjson).encode()))
    (work / "matrix.json.gz").write_bytes(
        gzip.compress(dumps_compact({"graph_fingerprint": fp, "rules_hash": rules_hash(), "matrix": matrix}).encode())
    )
    db = sqlite3.connect(work / "rest_route.sqlite")
    db.executescript(
        """
        CREATE TABLE seats (id TEXT PRIMARY KEY, source TEXT, type TEXT, routing_eligible INTEGER,
                            exclusion_reason TEXT, lon REAL, lat REAL, record_json TEXT NOT NULL);
        CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, category TEXT, lat REAL, lon REAL, source TEXT);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        """
    )
    for s in built.seats.values():
        rec = {k: v for k, v in s.__dict__.items()}
        db.execute(
            "INSERT INTO seats VALUES (?,?,?,?,?,?,?,?)",
            (s.id, s.source_refs[0]["source"], s.type, int(s.routing_eligible), s.exclusion_reason, s.lon, s.lat, json.dumps(rec)),
        )
    for p in places:
        db.execute("INSERT OR REPLACE INTO places VALUES (?,?,?,?,?,?)", (p["id"], p["name"], p["category"], p["lat"], p["lon"], p["source"]))
    db.execute("INSERT INTO meta VALUES ('dataset_version', ?)", (version,))
    db.execute("INSERT INTO meta VALUES ('cache_key', ?)", (f"{fp}:{rules_hash()}",))
    db.commit()
    db.close()

    reasons: dict[str, int] = {}
    for s in built.seats.values():
        if not s.routing_eligible:
            key = (s.exclusion_reason or "").split(" (")[0]
            reasons[key] = reasons.get(key, 0) + 1
    manifest = {
        "dataset": "live_pilot",
        "dataset_version": version,
        "area_name": area["name"],
        "area_description": area.get("description"),
        "service_polygon_lonlat": area["service_polygon_lonlat"],
        "routing_polygon_lonlat": routing_ring,
        "routing_buffer_m": area["routing_buffer_m"],
        "crs": UTM_CRS,
        "graph_fingerprint": fp,
        "rules": RULES,
        "rules_hash": rules_hash(),
        "retrieved": {"osm": imported_at, "nyc_dot_seating": None if args.skip_dot else imported_at},
        "source_updated": {"nyc_dot_seating": dot_updated},
        "sources": [
            {"name": "OpenStreetMap walking network", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL 1.0", "how": graph_how},
            {"name": "OpenStreetMap seating features", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL 1.0"},
            {"name": "NYC DOT Seating Locations (esmy-s8q5)", "url": NYC_DOT_SEATING_PAGE, "license": "NYC Open Data terms of use", "how": dot_how},
        ],
        "counts": {
            "graph_nodes": len(graph.nodes),
            "graph_segments": len(graph.segments),
            "osm_seat_records": len(osm_seats),
            "nyc_dot_seat_records": len(dot_seats),
            "seats_after_merge": len(built.seats),
            "eligible_seats": len(eligible),
            "excluded_seats": len(built.seats) - len(eligible),
            "places": len(places),
            "field_checks_applied": sum(1 for s in built.seats.values() if s.last_field_verified_at),
        },
        "excluded_by_reason": reasons,
        "merge_notes": built.merge_notes,
        "warnings": warnings,
        "timings_s": {**timings, "total_s": round(time.perf_counter() - t_start, 1)},
        "artifacts": {"graph": "graph.json.gz", "matrix": "matrix.json.gz", "database": "rest_route.sqlite"},
        "trips_json": json.dumps(trips),
    }
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    if out.exists():
        shutil.rmtree(out)
    work.rename(out)
    mdir = args.manifests_dir
    mdir.mkdir(parents=True, exist_ok=True)
    shutil.copy(out / "manifest.json", mdir / f"{version}.json")
    log(f"done: {version}")
    log(json.dumps(manifest["counts"]))
    if warnings:
        log("warnings: " + "; ".join(warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
