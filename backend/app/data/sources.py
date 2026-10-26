"""Adapters from raw source records to Rest Route's own formats.

These are pure functions so they can be unit-tested without network access.
The network fetching lives in scripts/prepare_pilot.py.

Sources
-------
* OpenStreetMap walking network (via OSMnx) -> PedGraph segments
* OpenStreetMap seating features (amenity=bench, bus stops / shelters with
  explicit seating tags) -> SeatRecord
* NYC DOT "Seating Locations" (NYC Open Data dataset esmy-s8q5) -> SeatRecord
  Field names verified against the dataset's published column list
  (https://data.cityofnewyork.us/api/views/esmy-s8q5/columns.json):
  siteid, asset_subtype, latitude, longitude, nearest_add, on_street,
  from_street, to_street, side_of_st, installation_date, asset_id, boroname.
  Asset_Subtype values seen in the column summary: BACKLESS 2.0, BACKED 1.0,
  BACKED 2.0, BACKLESS 1.0, LEANING BAR, WORLDS FAIR, UNKNOWN BENCH, or empty.
"""

from __future__ import annotations

import math

from ..routing.graph import PedGraph, Segment, polyline_length
from .seats import SeatRecord

NYC_DOT_SEATING_ID = "esmy-s8q5"
NYC_DOT_SEATING_PAGE = "https://data.cityofnewyork.us/Transportation/Seating-Locations/esmy-s8q5"
NYC_DOT_SODA_URL = "https://data.cityofnewyork.us/resource/esmy-s8q5.json"
NYC_DOT_METADATA_URL = "https://data.cityofnewyork.us/api/views/esmy-s8q5.json"

# OSMnx's default "walk" filter plus: no stairs, no foot=private.
# Paths tagged access=private are already excluded by OSMnx's default access rule.
WALK_FILTER = (
    '["highway"]["area"!~"yes"]["access"!~"private"]'
    '["highway"!~"abandoned|bus_guideway|construction|cycleway|motor|no|planned|platform|proposed|raceway|razed|steps"]'
    '["foot"!~"no|private"]["service"!~"private"]'
)

TRUE_VALUES = {"yes", "true", "1"}


def _tag(v):
    """OSMnx/GeoPandas give NaN for missing tags; normalise to None/str."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, list):
        return ";".join(str(x) for x in v)
    return str(v)


def _bool_tag(v) -> bool | None:
    v = _tag(v)
    if v is None:
        return None
    v = v.strip().lower()
    if v in TRUE_VALUES:
        return True
    if v in {"no", "false", "0"}:
        return False
    return None


def _access(v) -> str:
    v = (_tag(v) or "").lower()
    if v in {"private", "no", "customers", "permit"}:
        return "no"
    if v in {"yes", "public", "permissive", "designated"}:
        return "yes"
    return "unknown"


# ---------------------------------------------------------------------------
# Walking network


def osmnx_to_pedgraph(G_proj, crs: str) -> tuple[PedGraph, list[str]]:
    """Convert a *projected* OSMnx MultiDiGraph into a PedGraph.

    * Node ids become "osm:<id>".
    * Each OSM edge u->v with key k is matched with its reverse partner
      v->u (same OSM way, reversed geometry). A matched pair becomes one
      two-way segment; an unmatched edge becomes a one-way segment.
    * ``oneway:foot=yes`` (or ``-1``) on a way removes the forbidden
      direction even though OSMnx adds both directions for walk networks.
    * Lengths are recomputed from the projected geometry (meters).

    Returns the graph and a list of warnings.
    """
    warnings: list[str] = []
    g = PedGraph(crs)
    for n, d in G_proj.nodes(data=True):
        g.add_node(f"osm:{n}", (float(d["x"]), float(d["y"])))

    def coords(u, v, data):
        geom = data.get("geometry")
        if geom is not None:
            return [(float(x), float(y)) for x, y in geom.coords]
        return [g.nodes[f"osm:{u}"], g.nodes[f"osm:{v}"]]

    def key_of(xy):
        return tuple((round(x, 2), round(y, 2)) for x, y in xy)

    used: set[tuple] = set()
    edges = sorted(G_proj.edges(keys=True, data=True), key=lambda e: (str(e[0]), str(e[1]), str(e[2])))
    by_geom: dict[tuple, list] = {}
    for u, v, k, data in edges:
        by_geom.setdefault((u, v, key_of(coords(u, v, data))), []).append((u, v, k, data))

    n_oneway = 0
    for u, v, k, data in edges:
        if (u, v, k) in used:
            continue
        xy = coords(u, v, data)
        partner = None
        for cand in by_geom.get((v, u, key_of(list(reversed(xy)))), []):
            if (cand[0], cand[1], cand[2]) not in used and (cand[0], cand[1], cand[2]) != (u, v, k):
                partner = cand
                break
        used.add((u, v, k))
        fwd, bwd = True, partner is not None
        if partner is not None:
            used.add((partner[0], partner[1], partner[2]))
        ow = (_tag(data.get("oneway:foot")) or "").lower()
        if ow in TRUE_VALUES or ow == "-1":
            # OSMnx marks the copy that runs against the way's drawing order
            # with reversed=True; the drawn direction is reversed=False.
            rev = data.get("reversed")
            this_is_drawn = rev in (False, "False", None) if not isinstance(rev, list) else False
            want_drawn = ow in TRUE_VALUES
            if this_is_drawn == want_drawn:
                bwd = False
            else:
                fwd = False
            n_oneway += 1
        if not fwd and not bwd:
            continue
        tags = {
            "osmid": _tag(data.get("osmid")),
            "highway": _tag(data.get("highway")),
            "name": _tag(data.get("name")),
            "footway": _tag(data.get("footway")),
            "surface": _tag(data.get("surface")),
            "incline": _tag(data.get("incline")),
            "wheelchair": _tag(data.get("wheelchair")),
        }
        g.add_segment(
            Segment(
                id=f"e:{u}-{v}-{k}",
                a=f"osm:{u}",
                b=f"osm:{v}",
                xy=xy,
                length_m=polyline_length(xy),
                forward=fwd,
                backward=bwd,
                tags={t: val for t, val in tags.items() if val is not None},
            )
        )
    if n_oneway:
        warnings.append(f"{n_oneway} walkway(s) kept as one-way for pedestrians (oneway:foot)")
    return g, warnings


# ---------------------------------------------------------------------------
# OSM seating


def osm_feature_to_seat(element: str, osm_id, tags: dict, lon: float, lat: float, geom_type: str, imported_at: str) -> SeatRecord | None:
    """Normalise one OSM feature. Returns None if it is not seating at all."""
    t = {k: _tag(v) for k, v in tags.items()}
    amenity = (t.get("amenity") or "").lower()
    highway = (t.get("highway") or "").lower()
    bench_tag = (t.get("bench") or "").lower()
    bench_type = (t.get("bench:type") or "").lower()
    typ = None
    covered = _bool_tag(t.get("covered"))
    if amenity == "bench":
        typ = "leaning_bar" if ("stand" in bench_type or "lean" in bench_type or "stand" in bench_tag) else "bench"
    elif highway == "bus_stop":
        if bench_tag in TRUE_VALUES:
            typ = "bus_stop_bench"
        elif bench_tag in {"no", "false"}:
            return None
        elif (t.get("shelter") or "").lower() in TRUE_VALUES:
            typ = "shelter_unknown_seating"
        else:
            return None
        if (t.get("shelter") or "").lower() in TRUE_VALUES:
            covered = True
    elif amenity == "shelter":
        covered = True
        if bench_tag in TRUE_VALUES:
            typ = "shelter_bench"
        elif bench_tag in {"no", "false"}:
            return None
        else:
            typ = "shelter_unknown_seating"
    else:
        return None
    name = t.get("name")
    label = {
        "bench": "Bench",
        "leaning_bar": "Leaning bar",
        "bus_stop_bench": "Bus stop bench",
        "shelter_bench": "Shelter bench",
        "shelter_unknown_seating": "Shelter (seating not recorded)",
    }[typ]
    if name:
        label = f"{label}: {name}"
    return SeatRecord(
        id=f"osm-{element}-{osm_id}",
        lon=lon,
        lat=lat,
        type=typ,
        label=label,
        public_access=_access(t.get("access")),
        backrest=_bool_tag(t.get("backrest")),
        armrests=_bool_tag(t.get("armrest")),
        covered=covered,
        opening_hours=t.get("opening_hours"),
        imported_at=imported_at,
        source_refs=[
            {
                "source": "osm",
                "source_id": f"{element}/{osm_id}",
                "url": f"https://www.openstreetmap.org/{element}/{osm_id}",
                "geometry": geom_type,
                "imported_at": imported_at,
                "source_updated_at": None,
            }
        ],
    )


# ---------------------------------------------------------------------------
# NYC DOT seating


def normalise_dot_keys(row: dict) -> dict:
    """Accept both API field names (siteid) and CSV export headers (SiteID)."""
    return {str(k).strip().lower().replace(" ", "_"): v for k, v in row.items()}


def dot_row_to_seat(row: dict, imported_at: str, source_updated_at: str | None) -> SeatRecord | None:
    r = normalise_dot_keys(row)
    try:
        lat = float(r.get("latitude"))
        lon = float(r.get("longitude"))
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None
    site = _tag(r.get("siteid"))
    if not site:
        return None
    sub = (_tag(r.get("asset_subtype")) or "").strip().upper()
    backrest = None
    if "LEANING" in sub:
        typ = "leaning_bar"
    elif sub.startswith("BACKED"):
        typ, backrest = "bench", True
    elif sub.startswith("BACKLESS"):
        typ, backrest = "bench", False
    elif sub in {"WORLDS FAIR", "UNKNOWN BENCH"} or "BENCH" in sub:
        typ = "bench"
    else:
        typ = "unknown"
    where = _tag(r.get("nearest_add")) or _tag(r.get("on_street")) or "unknown address"
    label = f"NYC DOT {sub.title() if sub else 'seat (type not recorded)'} near {where}"
    return SeatRecord(
        id=f"dot-{site}",
        lon=lon,
        lat=lat,
        type=typ,
        label=label,
        public_access="yes",
        backrest=backrest,
        imported_at=imported_at,
        source_updated_at=source_updated_at,
        source_refs=[
            {
                "source": "nyc_dot_seating",
                "source_id": site,
                "url": NYC_DOT_SEATING_PAGE,
                "asset_subtype": sub or None,
                "installation_date": _tag(r.get("installation_date")),
                "on_street": _tag(r.get("on_street")),
                "side_of_street": _tag(r.get("side_of_st")),
                "imported_at": imported_at,
                "source_updated_at": source_updated_at,
            }
        ],
    )


def apply_field_checks(seats: list[SeatRecord], rows: list[dict]) -> list[str]:
    """Apply real field-check observations (data/field_checks.csv).

    Columns: seat_id, checked_at (YYYY-MM-DD), observed_status
    (present | missing | unusable), notes, checker. Only rows with a
    seat_id and checked_at are used. Returns warnings for unknown ids.
    """
    by_id = {s.id: s for s in seats}
    warnings = []
    for row in rows:
        sid = (row.get("seat_id") or "").strip()
        when = (row.get("checked_at") or "").strip()
        status = (row.get("observed_status") or "").strip().lower()
        if not sid or not when:
            continue
        s = by_id.get(sid)
        if s is None:
            warnings.append(f"field check for unknown seat id {sid}")
            continue
        if s.last_field_verified_at and s.last_field_verified_at >= when:
            continue
        s.last_field_verified_at = when
        s.availability_status = "field_checked" if status == "present" else "unavailable"
    return warnings
