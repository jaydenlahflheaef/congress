"""Loading routable datasets.

Two modes are kept strictly separate:

* ``synthetic_demo`` - the fictional fixture in data/fixtures, built in
  memory at startup with the same code as the real import.
* ``live_pilot`` - the Flushing pilot produced by scripts/prepare_pilot.py.
  If its artifacts are missing or inconsistent, the mode reports
  ``data_unavailable``. It never falls back to synthetic seats.
"""

from __future__ import annotations

import gzip
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from shapely.geometry import Polygon

from ..routing.graph import PedGraph, Segment, make_transformer, polyline_length
from .build import attach_seats, graph_fingerprint, graph_from_json, now_iso, seat_distance_matrix
from .seats import RULES, SeatRecord, rules_hash

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPO_ROOT / "data" / "fixtures" / "synthetic_demo.json"
DEFAULT_PILOT_DIR = REPO_ROOT / "data" / "pilot"


class DataUnavailable(Exception):
    pass


@dataclass
class Dataset:
    mode: str
    version: str
    area_name: str
    graph: PedGraph
    seats: dict[str, SeatRecord]
    seat_node: dict[str, str]
    matrix: dict[str, dict[str, float]]
    places: list[dict]
    trips: list[dict]
    service_polygon_xy: Polygon
    service_polygon_lonlat: list[list[float]]
    routing_polygon_lonlat: list[list[float]]
    manifest: dict
    rules_hash: str
    basemap_default: bool
    network_geojson: dict | None = None
    to_lonlat: object = field(default=None, repr=False)

    def public_config(self) -> dict:
        return {
            "mode": self.mode,
            "available": True,
            "dataset_version": self.version,
            "area_name": self.area_name,
            "service_polygon": self.service_polygon_lonlat,
            "routing_polygon": self.routing_polygon_lonlat,
            "basemap_default": self.basemap_default,
            "trips": self.trips,
            "counts": self.manifest.get("counts", {}),
            "retrieved": self.manifest.get("retrieved", {}),
            "sources": self.manifest.get("sources", []),
            "rules_hash": self.rules_hash,
        }


def _ring_lonlat(poly_xy: list[list[float]], to_ll) -> list[list[float]]:
    return [[round(c, 7) for c in to_ll(x, y)] for x, y in poly_xy]


def network_geojson(graph: PedGraph, to_ll) -> dict:
    feats = []
    for s in graph.segments.values():
        if s.kind != "path":
            continue
        feats.append(
            {
                "type": "Feature",
                "properties": {"id": s.id, "name": s.tags.get("name"), "oneway": s.forward != s.backward},
                "geometry": {"type": "LineString", "coordinates": [list(to_ll(x, y)) for x, y in s.xy]},
            }
        )
    return {"type": "FeatureCollection", "features": feats}


def load_synthetic(path: Path = FIXTURE_PATH) -> Dataset:
    return build_synthetic(json.loads(path.read_text()))


def build_synthetic(fx: dict) -> Dataset:
    """Build a dataset from a fixture dict (local meter coordinates).

    Segments may carry an explicit ``xy`` polyline (otherwise a straight
    line between the end nodes), ``forward``/``backward`` flags, and seats
    may carry ``public_access``, ``opening_hours``, ``availability_status``.
    """
    fx = {"places": [], "trips": [], "description": "", "name": "Test fixture", **fx}
    fx.setdefault("crs", "+proj=aeqd +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs")
    fx.setdefault("service_polygon_xy", [[-5000, -5000], [5000, -5000], [5000, 5000], [-5000, 5000], [-5000, -5000]])
    fx.setdefault("routing_polygon_xy", fx["service_polygon_xy"])
    crs = fx["crs"]
    to_ll = make_transformer(crs)
    g = PedGraph(crs)
    for nid, (x, y) in fx["nodes"].items():
        g.add_node(nid, (x, y))
    for s in fx["segments"]:
        xy = [tuple(p) for p in s["xy"]] if "xy" in s else [tuple(g.nodes[s["a"]]), tuple(g.nodes[s["b"]])]
        g.add_segment(
            Segment(
                id=s["id"],
                a=s["a"],
                b=s["b"],
                xy=xy,
                length_m=polyline_length(xy),
                forward=s.get("forward", True),
                backward=s.get("backward", True),
                tags={"name": s.get("name")},
            )
        )
    base_network = network_geojson(g, to_ll)
    imported = now_iso()
    seats = []
    for r in fx["seats"]:
        lon, lat = to_ll(r["x"], r["y"])
        seats.append(
            SeatRecord(
                id=r["id"],
                lon=lon,
                lat=lat,
                x=r["x"],
                y=r["y"],
                type=r["type"],
                label=r.get("label", ""),
                public_access=r.get("public_access", "yes"),
                backrest=r.get("backrest"),
                covered=r.get("covered"),
                opening_hours=r.get("opening_hours"),
                availability_status=r.get("availability_status", "on_record"),
                source_refs=[
                    {
                        "source": "synthetic",
                        "source_id": r["id"],
                        "url": None,
                        "note": "Fictional demo record",
                    }
                ],
                imported_at=imported,
            )
        )
    built = attach_seats(g, seats)
    matrix = seat_distance_matrix(g, built.seat_node)
    fp = graph_fingerprint(g)
    places = []
    for p in fx["places"]:
        lon, lat = to_ll(p["x"], p["y"])
        places.append({"id": p["id"], "name": p["name"], "category": p.get("category"), "lat": lat, "lon": lon, "source": "synthetic"})
    by_id = {p["id"]: p for p in places}
    trips = []
    for t in fx["trips"]:
        a, b = by_id[t["from"]], by_id[t["to"]]
        trips.append(
            {
                "id": t["id"],
                "name": t["name"],
                "from": {"name": a["name"], "lat": a["lat"], "lon": a["lon"]},
                "to": {"name": b["name"], "lat": b["lat"], "lon": b["lon"]},
                "suggested_limits_m": t.get("suggested_limits_m", []),
            }
        )
    eligible = sum(1 for s in built.seats.values() if s.routing_eligible)
    manifest = {
        "dataset": "synthetic_demo",
        "description": fx["description"],
        "graph_fingerprint": fp,
        "rules": RULES,
        "rules_hash": rules_hash(),
        "counts": {
            "seat_records": len(seats),
            "seats_after_merge": len(built.seats),
            "eligible_seats": eligible,
            "excluded_seats": len(built.seats) - eligible,
            "graph_nodes": len(g.nodes),
            "graph_segments": len(g.segments),
        },
        "retrieved": {"fixture": "bundled with the code"},
        "sources": [{"name": "Synthetic fixture", "url": None, "license": "Project fixture (fictional)"}],
        "warnings": built.warnings,
        "merge_notes": built.merge_notes,
    }
    return Dataset(
        mode="synthetic_demo",
        version=f"synthetic-{fp[:10]}-{rules_hash()}",
        area_name=fx["name"],
        graph=g,
        seats=built.seats,
        seat_node=built.seat_node,
        matrix=matrix,
        places=places,
        trips=trips,
        service_polygon_xy=Polygon(fx["service_polygon_xy"]),
        service_polygon_lonlat=_ring_lonlat(fx["service_polygon_xy"], to_ll),
        routing_polygon_lonlat=_ring_lonlat(fx["routing_polygon_xy"], to_ll),
        manifest=manifest,
        rules_hash=rules_hash(),
        basemap_default=False,
        network_geojson=base_network,
        to_lonlat=to_ll,
    )


def load_live(pilot_dir: Path = DEFAULT_PILOT_DIR) -> Dataset:
    """Load artifacts written by scripts/prepare_pilot.py.

    Raises DataUnavailable with a plain-language reason when anything is
    missing or does not match the manifest.
    """
    manifest_path = pilot_dir / "manifest.json"
    if not manifest_path.exists():
        raise DataUnavailable(
            "The Flushing pilot data has not been imported yet. Run scripts/prepare_pilot.py on a machine "
            "with internet access (see README)."
        )
    try:
        manifest = json.loads(manifest_path.read_text())
        art = manifest["artifacts"]
        graph = graph_from_json(json.loads(gzip.decompress((pilot_dir / art["graph"]).read_bytes())))
        matrix = json.loads(gzip.decompress((pilot_dir / art["matrix"]).read_bytes()))
        db_path = (pilot_dir / art["database"]).resolve()
        if not db_path.exists():
            raise OSError(f"missing {art['database']}")
        # Read-only and immutable: works on read-only file systems.
        db = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
        db.row_factory = sqlite3.Row
    except (OSError, KeyError, ValueError) as e:
        raise DataUnavailable(f"Pilot data files are missing or unreadable ({e.__class__.__name__}).") from e
    fp = graph_fingerprint(graph)
    if fp != manifest.get("graph_fingerprint"):
        raise DataUnavailable("Pilot graph does not match its manifest fingerprint; re-run the import.")
    if manifest.get("rules_hash") != rules_hash():
        raise DataUnavailable(
            "Pilot data was built with different seat-eligibility rules than this code; re-run the import."
        )
    if matrix.get("graph_fingerprint") != fp or matrix.get("rules_hash") != rules_hash():
        raise DataUnavailable("Distance cache does not match the graph or rules; re-run the import.")
    seats: dict[str, SeatRecord] = {}
    for row in db.execute("SELECT * FROM seats ORDER BY id"):
        rec = json.loads(row["record_json"])
        s = SeatRecord(**{k: v for k, v in rec.items() if k in SeatRecord.__dataclass_fields__})
        seats[s.id] = s
    places = [dict(r) for r in db.execute("SELECT id, name, category, lat, lon, source FROM places ORDER BY name")]
    trips = json.loads(manifest.get("trips_json", "[]"))
    db.close()
    seat_node = {sid: f"seat:{sid}" for sid, s in seats.items() if s.routing_eligible}
    missing = [n for n in seat_node.values() if n not in graph.nodes]
    if missing:
        raise DataUnavailable("Seat records reference nodes that are not in the graph; re-run the import.")
    to_ll = make_transformer(graph.crs)
    from pyproj import Transformer

    proj = Transformer.from_crs("EPSG:4326", graph.crs, always_xy=True)
    service_ll = manifest["service_polygon_lonlat"]
    service_xy = Polygon([proj.transform(lon, lat) for lon, lat in service_ll])
    return Dataset(
        mode="live_pilot",
        version=manifest["dataset_version"],
        area_name=manifest.get("area_name", "Flushing pilot"),
        graph=graph,
        seats=seats,
        seat_node=seat_node,
        matrix=matrix["matrix"],
        places=places,
        trips=trips,
        service_polygon_xy=service_xy,
        service_polygon_lonlat=service_ll,
        routing_polygon_lonlat=manifest["routing_polygon_lonlat"],
        manifest=manifest,
        rules_hash=rules_hash(),
        basemap_default=True,
        network_geojson=None,
        to_lonlat=to_ll,
    )
