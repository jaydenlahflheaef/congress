"""New York City data: the city outline, OpenStreetMap tiles and NYC DOT seating.

Everything here is written by scripts/update_nyc_data.py and committed, so the
server reads it from disk and never calls OpenStreetMap or NYC Open Data
while someone waits.

OSM tiles are a fixed lon/lat grid (TILE_LON x TILE_LAT degrees, about
1.7 km square in NYC). Each tile file lists the walkway segments and seating
features that touch it:

* segments: [id, node_a, node_b, way_id, flags, tags, coords] where flags
  bit 1 = walk a->b allowed, bit 2 = walk b->a allowed, and coords is a flat
  list of lon/lat in millionths of a degree.
* seats: [element, osm_id, lon, lat, geometry_type, tags]
"""

from __future__ import annotations

import gzip
import json
import math
from functools import lru_cache

from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.prepared import prep

from ..routing.graph import PedGraph, Segment, polyline_length
from .dataset import REPO_ROOT
from .seats import SeatRecord
from .sources import NYC_DOT_SEATING_PAGE, dot_row_to_seat, osm_feature_to_seat

NYC_DIR = REPO_ROOT / "data" / "nyc"
BOUNDARY_PATH = NYC_DIR / "boundary.json"
DOT_PATH = NYC_DIR / "dot_seating.json.gz"
OSM_DIR = NYC_DIR / "osm"
SEEDS_DIR = NYC_DIR / "seeds"
TILE_LON, TILE_LAT = 0.02, 0.015
COORD_SCALE = 1e6
# Walkway pieces that connect to nothing else (a footway reached only by
# stairs, a fragment cut off by an indoor passage) can never be part of a
# route, but a start, destination or seat attached to one is stranded. In
# sampled NYC areas the main network has thousands of nodes and every
# separate piece has fewer than 25, so pieces under this size are dropped.
MIN_PIECE_NODES = 50
OUTSIDE_NYC = "EzWay covers New York City. Choose a start and destination in the five boroughs."


class Region:
    """A lon/lat outline that trips must start and end inside."""

    def __init__(self, geometry, name: str, outside_message: str):
        self.geometry = geometry
        self.name = name
        self.outside_message = outside_message
        self._prepared = prep(geometry)

    def covers(self, lat: float, lon: float) -> bool:
        return self._prepared.covers(Point(lon, lat))

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return self.geometry.bounds


@lru_cache(maxsize=1)
def nyc_region() -> Region:
    d = json.loads(BOUNDARY_PATH.read_text())
    return Region(shape(d["geometry"]), d["name"], OUTSIDE_NYC)


def tile_of(lon: float, lat: float) -> tuple[int, int]:
    return math.floor(lon / TILE_LON), math.floor(lat / TILE_LAT)


@lru_cache(maxsize=1)
def osm_meta() -> dict:
    """Extract date, source and counts for the committed OSM tiles ({} if missing)."""
    try:
        return json.loads((OSM_DIR / "meta.json").read_text())
    except OSError:
        return {}


def _tiles(bounds):
    # Not cached: a handful of tiles decompress in well under a second, and
    # keeping them would cost more memory than a small server has.
    (x0, y0), (x1, y1) = tile_of(bounds[0], bounds[1]), tile_of(bounds[2], bounds[3])
    for ix in range(x0, x1 + 1):
        for iy in range(y0, y1 + 1):
            try:
                yield json.loads(gzip.decompress((OSM_DIR / f"{ix}_{iy}.json.gz").read_bytes()))
            except FileNotFoundError:
                continue


def _without_small_pieces(picked: list) -> list:
    parent: dict = {}

    def root(n):
        while parent.setdefault(n, n) != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for p in picked:
        parent[root(p[1])] = root(p[2])
    size: dict = {}
    for n in parent:
        size[root(n)] = size.get(root(n), 0) + 1
    return [p for p in picked if size[root(p[1])] >= MIN_PIECE_NODES]


def osm_area(routing_lonlat, crs: str) -> tuple[PedGraph, list[SeatRecord]]:
    """Walkways touching a lon/lat polygon, projected to ``crs``, and the OSM seats inside it."""
    area = prep(routing_lonlat)
    minx, miny, maxx, maxy = routing_lonlat.bounds
    imported = osm_meta().get("extract_date")
    picked, seats, seen = [], [], set()
    for tile in _tiles(routing_lonlat.bounds):
        for sid, a, b, way, flags, tags, flat in tile["segments"]:
            if sid in seen:
                continue
            lons = [v / COORD_SCALE for v in flat[0::2]]
            lats = [v / COORD_SCALE for v in flat[1::2]]
            if max(lons) < minx or min(lons) > maxx or max(lats) < miny or min(lats) > maxy:
                continue
            if not area.intersects(LineString(list(zip(lons, lats)))):
                continue
            seen.add(sid)
            picked.append((sid, a, b, way, flags, tags, lons, lats))
        for element, oid, lon, lat, geom_type, tags in tile["seats"]:
            key = f"{element}/{oid}"
            if key in seen or not area.covers(Point(lon, lat)):
                continue
            seen.add(key)
            s = osm_feature_to_seat(element, oid, tags, lon, lat, geom_type, imported)
            if s:
                seats.append(s)
    picked = _without_small_pieces(picked)
    proj = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    # One projection call for every coordinate is far faster than one per point.
    xs, ys = proj.transform([v for p in picked for v in p[6]], [v for p in picked for v in p[7]])
    graph = PedGraph(crs)
    i = 0
    for sid, a, b, way, flags, tags, lons, lats in picked:
        xy = list(zip(xs[i:i + len(lons)], ys[i:i + len(lons)]))
        i += len(lons)
        graph.add_node(f"osm:{a}", xy[0])
        graph.add_node(f"osm:{b}", xy[-1])
        graph.add_segment(Segment(id=sid, a=f"osm:{a}", b=f"osm:{b}", xy=xy, length_m=polyline_length(xy),
                                  forward=bool(flags & 1), backward=bool(flags & 2), tags={**tags, "osmid": str(way)}))
    for s in seats:
        s.x, s.y = proj.transform(s.lon, s.lat)
    return graph, seats


def nearest_walkway(lat: float, lon: float, max_m: float) -> tuple[float, float, float] | None:
    """(lat, lon, meters) of the closest point on a walkway within ``max_m``, or None.

    Uses a local flat approximation, which is accurate to well under a meter
    over a few hundred meters; it only picks a point, it never measures a route.
    """
    mx, my = 111_320 * math.cos(math.radians(lat)), 110_540
    dlon, dlat = max_m / mx, max_m / my
    best = None
    for tile in _tiles((lon - dlon, lat - dlat, lon + dlon, lat + dlat)):
        for seg in tile["segments"]:
            flat = seg[6]
            xs = [(v / COORD_SCALE - lon) * mx for v in flat[0::2]]
            ys = [(v / COORD_SCALE - lat) * my for v in flat[1::2]]
            if min(xs) > max_m or max(xs) < -max_m or min(ys) > max_m or max(ys) < -max_m:
                continue
            for x1, y1, x2, y2 in zip(xs, ys, xs[1:], ys[1:]):
                dx, dy = x2 - x1, y2 - y1
                t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
                px, py = x1 + t * dx, y1 + t * dy
                d = math.hypot(px, py)
                if d <= max_m and (best is None or d < best[2]):
                    best = (lat + py / my, lon + px / mx, d)
    return best


@lru_cache(maxsize=1)
def dot_snapshot() -> dict:
    """{"retrieved", "source_updated", "rows"}; empty rows if the file is missing."""
    try:
        return json.loads(gzip.decompress(DOT_PATH.read_bytes()))
    except OSError:
        return {"retrieved": None, "source_updated": None, "rows": []}


def dot_seats_within(polygon_lonlat, imported_at: str) -> tuple[list[SeatRecord], dict | None]:
    """NYC DOT seats inside a lon/lat polygon, plus a manifest source entry (None if none)."""
    snap = dot_snapshot()
    area = prep(polygon_lonlat)
    seats = []
    for row in snap["rows"]:
        s = dot_row_to_seat(row, snap["retrieved"] or imported_at, snap["source_updated"])
        if s and area.covers(Point(s.lon, s.lat)):
            seats.append(s)
    if not seats:
        return [], None
    source = {
        "name": "NYC DOT Seating Locations (esmy-s8q5)",
        "url": NYC_DOT_SEATING_PAGE,
        "license": "NYC Open Data terms of use",
        "how": f"snapshot retrieved {(snap['retrieved'] or '')[:10]}, dataset updated {(snap['source_updated'] or '')[:10]}",
    }
    return seats, source
