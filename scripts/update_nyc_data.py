#!/usr/bin/env python3
"""Refresh the New York City files the server reads.

Run from the repository root on a computer with internet access:

    python scripts/update_nyc_data.py

What it writes (commit all of it; the server never downloads anything)
---------------------------------------------------------------------
data/nyc/boundary.json        New York City's outline (OpenStreetMap, via
                              Nominatim), simplified and widened by about
                              300 m so points on the shoreline still count.
data/nyc/dot_seating.json.gz  Every record of NYC DOT "Seating Locations"
                              (dataset esmy-s8q5), with the retrieval time and
                              the dataset's own last-updated time.
data/nyc/osm/                 Walkways and seating features from an
                              OpenStreetMap extract of New York, cut into
                              tiles (see backend/app/data/nyc.py), plus
                              meta.json with the extract date.
data/nyc/seeds/flushing.json.gz
                              The downtown Flushing area (data/pilot_area.json)
                              built ahead of time, with the example trips in
                              data/pilot_trips.json, so it opens instantly.

The OSM extract (about 150 MB) is downloaded from BBBike.org into
data/nyc/raw/, which Git ignores. Use --pbf to read a file you already have.

Options
-------
--pbf FILE        use an existing New York .osm.pbf extract
--only STEPS      comma-separated subset of: boundary,dot,osm,seed
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sys
import time
from collections import Counter, defaultdict
from email.utils import parsedate_to_datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.data.build import now_iso  # noqa: E402
from app.data.nyc import COORD_SCALE, NYC_DIR, OSM_DIR, SEEDS_DIR, TILE_LAT, TILE_LON, tile_of  # noqa: E402
from app.data.sources import NYC_DOT_METADATA_URL, NYC_DOT_SODA_URL, foot_directions, is_walkable_way  # noqa: E402

USER_AGENT = "EzWay-student-project/0.1 (Congressional App Challenge; contact via repository)"
PBF_URL = "https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf"
STEPS = ("boundary", "dot", "osm", "seed")
# Only the fields dot_row_to_seat reads, to keep the committed file small.
DOT_FIELDS = [
    "siteid", "asset_subtype", "latitude", "longitude", "nearest_add",
    "on_street", "side_of_st", "installation_date", "boroname",
]
# Only the tags the router and osm_feature_to_seat read.
SEGMENT_TAGS = ("highway", "name", "footway", "surface", "incline", "wheelchair")
SEAT_TAGS = ("amenity", "highway", "bench", "bench:type", "covered", "shelter", "name", "access", "backrest", "armrest", "opening_hours")


def log(msg: str) -> None:
    print(f"[nyc] {msg}", flush=True)


def write_gz(path: Path, obj) -> None:
    path.write_bytes(gzip.compress(json.dumps(obj, separators=(",", ":")).encode(), mtime=0))


def write_boundary() -> None:
    import osmnx as ox
    from shapely.geometry import mapping

    ox.settings.http_user_agent = USER_AGENT
    ox.settings.use_cache = False
    log("downloading the New York City boundary (Nominatim)…")
    gdf = ox.geocode_to_gdf("New York City, New York, United States")
    shape = gdf.geometry.iloc[0].simplify(0.001).buffer(0.003, join_style="mitre").simplify(0.001)
    geo = mapping(shape)

    def rounded(c):
        return [rounded(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 5), round(c[1], 5)]

    out = {
        "name": "New York City",
        "source": "OpenStreetMap relation via Nominatim, simplified 0.001 deg and buffered 0.003 deg",
        "license": "ODbL 1.0",
        "retrieved": now_iso(),
        "geometry": {"type": geo["type"], "coordinates": rounded(geo["coordinates"])},
    }
    (NYC_DIR / "boundary.json").write_text(json.dumps(out, separators=(",", ":")))
    log(f"boundary: {geo['type']}, bounds {tuple(round(v, 3) for v in shape.bounds)}")


def write_dot_seating() -> None:
    import requests

    headers = {"User-Agent": USER_AGENT}
    log("downloading NYC DOT Seating Locations (SODA API)…")
    r = requests.get(
        NYC_DOT_SODA_URL,
        params={"$select": ",".join(DOT_FIELDS), "$limit": "50000", "$order": "siteid"},
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    rows = r.json()
    meta = requests.get(NYC_DOT_METADATA_URL, headers=headers, timeout=30).json()
    ts = meta.get("rowsUpdatedAt")
    out = {
        "retrieved": now_iso(),
        "source_updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts))) if ts else None,
        "rows": rows,
    }
    write_gz(NYC_DIR / "dot_seating.json.gz", out)
    log(f"NYC DOT seating: {len(rows)} records, dataset updated {out['source_updated']}")


def fetch_pbf() -> tuple[Path, str | None]:
    """Download the BBBike New York extract; returns the path and its Last-Modified date."""
    import requests

    path = NYC_DIR / "raw" / "NewYork.osm.pbf"
    path.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading {PBF_URL} (about 150 MB)…")
    with requests.get(PBF_URL, headers={"User-Agent": USER_AGENT}, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            shutil.copyfileobj(r.raw, f)
        modified = r.headers.get("Last-Modified")
    return path, parsedate_to_datetime(modified).strftime("%Y-%m-%dT%H:%M:%SZ") if modified else None


def extract_date(pbf: Path, fallback: str | None) -> str:
    import osmium

    header = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING).header()
    stamp = header.get("osmosis_replication_timestamp") or header.get("timestamp")
    if stamp:
        return stamp
    return fallback or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(pbf.stat().st_mtime))


def write_osm_tiles(pbf: Path, date: str) -> None:
    import osmium
    from shapely.geometry import LineString, Point, Polygon, box, shape
    from shapely.prepared import prep

    boundary = shape(json.loads((NYC_DIR / "boundary.json").read_text())["geometry"])
    # About 600 m past the city line, so areas near the edge keep their routing buffer.
    keep = prep(boundary.buffer(0.006))
    walk, seat_rows = [], []
    log(f"reading {pbf.name}…")
    reader = osmium.FileProcessor(str(pbf)).with_locations().with_filter(osmium.filter.KeyFilter("highway", "amenity"))
    for obj in reader:
        tags = {t.k: t.v for t in obj.tags}
        is_seat = tags.get("amenity") in ("bench", "shelter") or tags.get("highway") == "bus_stop"
        seat_tags = {k: tags[k] for k in SEAT_TAGS if k in tags}
        if obj.is_node():
            if is_seat and keep.covers(Point(obj.lon, obj.lat)):
                seat_rows.append(["node", obj.id, round(obj.lon, 7), round(obj.lat, 7), "Point", seat_tags])
            continue
        if not obj.is_way() or not (is_seat or is_walkable_way(tags)):
            continue
        try:
            pts = [(n.ref, n.lon, n.lat) for n in obj.nodes]
        except osmium.InvalidLocationError:
            continue  # the way runs past the edge of the extract
        if len(pts) < 2:
            continue
        lons, lats = [p[1] for p in pts], [p[2] for p in pts]
        if not keep.intersects(box(min(lons), min(lats), max(lons), max(lats))):
            continue
        if is_walkable_way(tags):
            fwd, bwd = foot_directions(tags)
            walk.append((obj.id, pts, {k: tags[k] for k in SEGMENT_TAGS if k in tags}, int(fwd) | (2 * int(bwd))))
        if is_seat:
            closed = len(pts) >= 4 and pts[0][0] == pts[-1][0]
            geom = Polygon(zip(lons, lats)) if closed else LineString(zip(lons, lats))
            rp = geom.representative_point()
            seat_rows.append(["way", obj.id, round(rp.x, 7), round(rp.y, 7), geom.geom_type, seat_tags])
    log(f"{len(walk)} walkable ways, {len(seat_rows)} seating features")

    # Split ways where another way joins, like OSMnx's simplified graph.
    uses = Counter(ref for _, pts, _, _ in walk for ref, _, _ in pts)
    tiles = defaultdict(lambda: {"segments": [], "seats": []})
    n_segments = 0
    for way_id, pts, tags, flags in walk:
        cuts = [0] + [i for i in range(1, len(pts) - 1) if uses[pts[i][0]] > 1] + [len(pts) - 1]
        for k, (i, j) in enumerate(zip(cuts, cuts[1:])):
            piece = pts[i:j + 1]
            flat = [round(v * COORD_SCALE) for _, lon, lat in piece for v in (lon, lat)]
            seg = [f"e:w{way_id}.{k}", piece[0][0], piece[-1][0], way_id, flags, tags, flat]
            (x0, y0), (x1, y1) = tile_of(min(p[1] for p in piece), min(p[2] for p in piece)), tile_of(max(p[1] for p in piece), max(p[2] for p in piece))
            for ix in range(x0, x1 + 1):
                for iy in range(y0, y1 + 1):
                    tiles[(ix, iy)]["segments"].append(seg)
            n_segments += 1
    for row in seat_rows:
        tiles[tile_of(row[2], row[3])]["seats"].append(row)

    if OSM_DIR.exists():
        shutil.rmtree(OSM_DIR)
    OSM_DIR.mkdir(parents=True)
    digest = hashlib.sha256()
    for ix, iy in sorted(tiles):
        path = OSM_DIR / f"{ix}_{iy}.json.gz"
        write_gz(path, tiles[(ix, iy)])
        digest.update(path.read_bytes())
    meta = {
        # The content digest changes whenever the walkway rules change, even for the same extract.
        "version": f"osm-{date[:10]}-{digest.hexdigest()[:8]}",
        "extract_date": date,
        "source": f"BBBike.org New York extract of OpenStreetMap ({PBF_URL}), dated {date[:10]}",
        "license": "ODbL 1.0",
        "tile_deg": [TILE_LON, TILE_LAT],
        "counts": {"walkable_ways": len(walk), "segments": n_segments, "seating_features": len(seat_rows), "tiles": len(tiles)},
    }
    (OSM_DIR / "meta.json").write_text(json.dumps(meta, indent=2))
    size = sum(p.stat().st_size for p in OSM_DIR.iterdir()) / 1e6
    log(f"{n_segments} segments in {len(tiles)} tiles, {size:.1f} MB")


def write_flushing_seed() -> None:
    from shapely.geometry import Polygon

    from app.data import nyc
    from app.data.nearby import build_area

    nyc.osm_meta.cache_clear()
    nyc.dot_snapshot.cache_clear()
    area = json.loads((REPO / "data" / "pilot_area.json").read_text())
    log(f"building the seeded area: {area['name']}…")
    t = time.perf_counter()
    payload = build_area(Polygon(area["service_polygon_lonlat"]), log)
    trips = json.loads((REPO / "data" / "pilot_trips.json").read_text())
    payload["area_name"] = "Downtown Flushing"
    payload["trips"] = [
        {"id": t_["id"], "name": t_["name"], "from": t_["from"], "to": t_["to"], "suggested_limits_m": t_["suggested_limits_m"]}
        for t_ in trips if "from" in t_ and "to" in t_
    ]
    SEEDS_DIR.mkdir(parents=True, exist_ok=True)
    write_gz(SEEDS_DIR / "flushing.json.gz", payload)
    log(f"Flushing seed: {payload['manifest']['counts']} in {time.perf_counter() - t:.1f} s")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pbf", type=Path)
    ap.add_argument("--only", default=",".join(STEPS))
    args = ap.parse_args()
    steps = {s.strip() for s in args.only.split(",")}
    if steps - set(STEPS):
        ap.error(f"--only accepts {', '.join(STEPS)}")
    NYC_DIR.mkdir(parents=True, exist_ok=True)
    if "boundary" in steps:
        write_boundary()
    if "dot" in steps:
        write_dot_seating()
    if "osm" in steps:
        pbf, modified = (args.pbf, None) if args.pbf else fetch_pbf()
        write_osm_tiles(pbf, extract_date(pbf, modified))
    if "seed" in steps:
        write_flushing_seed()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
