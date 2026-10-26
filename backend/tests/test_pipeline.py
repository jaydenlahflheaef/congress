"""Import pipeline tests, run fully offline.

The real import downloads OpenStreetMap and NYC Open Data. These tests feed
the same script small hand-made inputs shaped like those sources (an OSMnx
GraphML file, an OSM features GeoJSON and a CSV with the NYC DOT export
headers). The inputs are test fixtures, not real Flushing data.
"""

import csv
import json
import subprocess
import sys
from pathlib import Path

import networkx as nx
import pytest
from shapely.geometry import LineString, Point

from app.data.dataset import load_live
from app.data.sources import dot_row_to_seat, osm_feature_to_seat, osmnx_to_pedgraph
from app.routing.planner import Planner

REPO = Path(__file__).resolve().parents[2]

# A small fake street grid near Main St & Roosevelt Ave (lon, lat).
NODES = {
    1: (-73.8310, 40.7590),
    2: (-73.8290, 40.7590),
    3: (-73.8270, 40.7590),
    4: (-73.8310, 40.7605),
    5: (-73.8290, 40.7605),
    6: (-73.8270, 40.7605),
}
WAYS = [(1, 2, 101), (2, 3, 101), (4, 5, 102), (5, 6, 102), (1, 4, 103), (2, 5, 104), (3, 6, 105)]


def write_fake_graphml(path: Path):
    import osmnx as ox

    G = nx.MultiDiGraph(crs="EPSG:4326")
    for n, (lon, lat) in NODES.items():
        G.add_node(n, x=lon, y=lat, street_count=3)
    for u, v, wid in WAYS:
        geom = LineString([NODES[u], NODES[v]])
        extra = {}
        if (u, v) == (2, 5):
            extra["oneway:foot"] = "yes"
        for a, b, rev in ((u, v, False), (v, u, True)):
            g = geom if not rev else LineString(list(reversed(geom.coords)))
            G.add_edge(a, b, key=0, osmid=wid, highway="footway", oneway=False, reversed=rev, length=geom.length * 1e5, geometry=g, **extra)
    ox.save_graphml(G, path)


def write_fake_osm_features(path: Path, rows):
    import geopandas as gpd

    gdf = gpd.GeoDataFrame(rows, geometry=[Point(r.pop("lon"), r.pop("lat")) for r in rows], crs="EPSG:4326")
    gdf.to_file(path, driver="GeoJSON")


def test_osm_and_dot_adapters():
    s = osm_feature_to_seat("node", 9, {"amenity": "bench", "backrest": "yes", "access": "private"}, -73.83, 40.76, "Point", "t")
    assert s.type == "bench" and s.backrest is True and s.public_access == "no"
    assert s.source_refs[0]["url"] == "https://www.openstreetmap.org/node/9"
    assert osm_feature_to_seat("node", 1, {"highway": "bus_stop", "shelter": "yes"}, 0, 0, "Point", "t").type == "shelter_unknown_seating"
    assert osm_feature_to_seat("node", 1, {"highway": "bus_stop", "bench": "yes"}, 0, 0, "Point", "t").type == "bus_stop_bench"
    assert osm_feature_to_seat("node", 1, {"highway": "bus_stop"}, 0, 0, "Point", "t") is None
    assert osm_feature_to_seat("node", 1, {"amenity": "bench", "bench:type": "stand_up"}, 0, 0, "Point", "t").type == "leaning_bar"
    # API field names and CSV export headers both work
    api = dot_row_to_seat({"siteid": "S1", "asset_subtype": "BACKED 2.0", "latitude": "40.76", "longitude": "-73.83"}, "t", None)
    csvrow = dot_row_to_seat({"SiteID": "S2", "Asset_Subtype": "LEANING BAR", "Latitude": "40.76", "Longitude": "-73.83"}, "t", None)
    blank = dot_row_to_seat({"SiteID": "S3", "Asset_Subtype": "", "Latitude": "40.76", "Longitude": "-73.83"}, "t", None)
    assert (api.type, api.backrest) == ("bench", True)
    assert csvrow.type == "leaning_bar"
    assert blank.type == "unknown"
    assert dot_row_to_seat({"SiteID": "S4", "Latitude": "x", "Longitude": "1"}, "t", None) is None
    assert api.last_field_verified_at is None


def test_osmnx_conversion_pairs_directions_and_oneway_foot(tmp_path):
    import osmnx as ox

    gml = tmp_path / "g.graphml"
    write_fake_graphml(gml)
    Gp = ox.project_graph(ox.load_graphml(gml), to_crs="EPSG:32618")
    g, warnings = osmnx_to_pedgraph(Gp, "EPSG:32618")
    assert len(g.segments) == len(WAYS)
    oneway = [s for s in g.segments.values() if s.forward != s.backward]
    assert len(oneway) == 1 and warnings
    seg = oneway[0]
    # the allowed direction is the way's drawn direction 2 -> 5
    allowed_from = seg.a if seg.forward else seg.b
    assert allowed_from == "osm:2"
    # ~167 m between latitude 40.7590 and 40.7605
    assert 160 < seg.length_m < 175


def test_prepare_pilot_offline_end_to_end(tmp_path):
    gml = tmp_path / "osm_walk.graphml"
    write_fake_graphml(gml)
    seats_gj = tmp_path / "seats.geojson"
    write_fake_osm_features(
        seats_gj,
        [
            {"element": "node", "id": 1, "amenity": "bench", "lon": -73.8300, "lat": 40.75902},
            {"element": "node", "id": 2, "highway": "bus_stop", "shelter": "yes", "lon": -73.8280, "lat": 40.75902},
        ],
    )
    places_gj = tmp_path / "places.geojson"
    write_fake_osm_features(
        places_gj,
        [
            {"element": "node", "id": 10, "name": "Test Place West", "amenity": "library", "lon": -73.8310, "lat": 40.75895},
            {"element": "node", "id": 11, "name": "Test Place East", "amenity": "clinic", "lon": -73.8270, "lat": 40.75895},
        ],
    )
    dot_csv = tmp_path / "dot.csv"
    with open(dot_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["SiteID", "Asset_Subtype", "Latitude", "Longitude", "Nearest_Add"])
        w.writeheader()
        w.writerow({"SiteID": "T1", "Asset_Subtype": "BACKED 2.0", "Latitude": 40.76052, "Longitude": -73.8280, "Nearest_Add": "test"})
        w.writerow({"SiteID": "T2", "Asset_Subtype": "LEANING BAR", "Latitude": 40.76052, "Longitude": -73.8300, "Nearest_Add": "test"})
        w.writerow({"SiteID": "T3", "Asset_Subtype": "BACKLESS 1.0", "Latitude": 40.75902, "Longitude": -73.83001, "Nearest_Add": "dup"})
    trips = tmp_path / "trips.json"
    trips.write_text(json.dumps([{"id": "t", "name": "test trip", "from_place": "West", "to_place": ["Nope", "East"]}]))
    out = tmp_path / "pilot"
    cmd = [
        sys.executable, str(REPO / "scripts" / "prepare_pilot.py"),
        "--out", str(out), "--manifests-dir", str(tmp_path / "manifests"),
        "--osm-graphml", str(gml), "--osm-seats-geojson", str(seats_gj), "--osm-places-geojson", str(places_gj),
        "--dot-csv", str(dot_csv), "--trips", str(trips),
        "--field-checks", str(tmp_path / "none.csv"), "--curated-places", str(tmp_path / "none.json"),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    assert res.returncode == 0, res.stdout + res.stderr
    manifest = json.loads((out / "manifest.json").read_text())
    c = manifest["counts"]
    assert c["osm_seat_records"] == 2 and c["nyc_dot_seat_records"] == 3
    assert c["eligible_seats"] == 2  # OSM bench (merged with DOT T3) + DOT T1
    assert manifest["merge_notes"] == ["merged osm-node-1 into dot-T3"]
    assert any("Leaning bar" in k for k in manifest["excluded_by_reason"])
    ds = load_live(out)
    assert ds.mode == "live_pilot" and ds.version == manifest["dataset_version"]
    assert ds.seats["dot-T3"].seat_count == 2
    assert [t["id"] for t in ds.trips] == ["t"]
    p = Planner(ds)
    t = ds.trips[0]
    r = p.plan((t["from"]["lon"], t["from"]["lat"]), (t["to"]["lon"], t["to"]["lat"]), 150, [])
    assert r["status"] in ("ok", "limit_unmet") and r["data_mode"] == "live_pilot"
    assert 330 < r["comparison_distance_m"] < 350  # ~0.004 deg of longitude at 40.76 N
    # tamper with the graph -> server must refuse instead of guessing
    (out / "graph.json.gz").write_bytes(b"not gzip")
    from app.data.dataset import DataUnavailable

    with pytest.raises(DataUnavailable):
        load_live(out)
