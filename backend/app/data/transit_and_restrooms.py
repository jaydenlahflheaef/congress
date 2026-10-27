"""NYC Subway station elevator outage alerts, monthly reliability, and Public Restrooms.

Data sources:
- NY State Open Data (MTA Subway Stations `39hk-dx4f`, Elevator & Escalator Inventory `94fv-bak7`,
  Monthly Elevator & Escalator Availability `rc78-7x78`)
- MTA Live Elevator & Escalator Outages (`nyct_ene.json`), with automatic fallback to the
  committed snapshot in `data/nyc/subway_elevators.json.gz` so tests and offline runs never fail.
- NYC Open Data Public Restrooms (`i7jb-7jku`), stored in `data/nyc/public_restrooms.json.gz`.
"""

from __future__ import annotations

import gzip
import json
import math
import time
from functools import lru_cache
from typing import Any

import requests
from shapely.geometry import Point
from shapely.prepared import prep

from .dataset import REPO_ROOT

NYC_DIR = REPO_ROOT / "data" / "nyc"
SUBWAY_PATH = NYC_DIR / "subway_elevators.json.gz"
RESTROOMS_PATH = NYC_DIR / "public_restrooms.json.gz"

MTA_ENE_LIVE_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json"
MTA_STATIONS_PAGE = "https://www.mta.info/accessibility/stations"
NYC_RESTROOMS_PAGE = "https://data.cityofnewyork.us/City-Government/Public-Restrooms/i7jb-7jku"

STATION_MATCH_M = 280.0
LIVE_OUTAGE_TTL_S = 180.0

_live_outage_cache: dict[str, Any] = {
    "fetched_at": 0.0,
    "rows": None,
    "source": "snapshot",
    "updated_at": None,
}


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Fast local flat-earth distance in meters (accurate within <0.2% at NYC scale)."""
    mx = 111_320.0 * math.cos(math.radians((lat1 + lat2) * 0.5))
    my = 110_540.0
    return math.hypot((lon2 - lon1) * mx, (lat2 - lat1) * my)


@lru_cache(maxsize=1)
def subway_snapshot() -> dict[str, Any]:
    """Load the committed subway stations, elevator inventory, monthly reliability, and outage snapshot."""
    try:
        return json.loads(gzip.decompress(SUBWAY_PATH.read_bytes()))
    except OSError:
        return {
            "retrieved": None,
            "sources": {},
            "stations": [],
            "elevators": [],
            "availability_2026": [],
            "outages_snapshot": [],
        }


@lru_cache(maxsize=1)
def restrooms_snapshot() -> dict[str, Any]:
    """Load the committed NYC Public Restrooms dataset."""
    try:
        return json.loads(gzip.decompress(RESTROOMS_PATH.read_bytes()))
    except OSError:
        return {"retrieved": None, "source": NYC_RESTROOMS_PAGE, "rows": []}


def get_elevator_outages(*, allow_live: bool = False) -> tuple[list[dict[str, Any]], str, str | None]:
    """Return (outage_rows, source_type, updated_at_iso).

    By default, uses the committed snapshot (or recently cached live feed) so
    route planning stays fast and deterministic. When `allow_live=True`, tries
    fetching the live MTA ENE feed with a short 2.5s timeout and caches it for 3 minutes.
    """
    snap = subway_snapshot()
    now = time.time()
    if _live_outage_cache["rows"] is not None and (now - _live_outage_cache["fetched_at"] < LIVE_OUTAGE_TTL_S):
        return _live_outage_cache["rows"], _live_outage_cache["source"], _live_outage_cache["updated_at"]

    if allow_live:
        try:
            r = requests.get(
                MTA_ENE_LIVE_URL,
                headers={"User-Agent": "EzWay/0.2 (Congressional App Challenge)"},
                timeout=2.5,
            )
            r.raise_for_status()
            rows = r.json()
            if isinstance(rows, list):
                stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                _live_outage_cache.update(
                    {"fetched_at": now, "rows": rows, "source": "live_mta", "updated_at": stamp}
                )
                return rows, "live_mta", stamp
        except Exception:
            pass

    rows = snap.get("outages_snapshot") or []
    return rows, "snapshot", snap.get("retrieved")


def _ada_label(ada_val: str | None) -> str:
    if str(ada_val) == "1":
        return "ADA accessible"
    if str(ada_val) == "2":
        return "Partially accessible"
    return "Not ADA accessible (stairs)"


def stations_near_endpoints(
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    mode: str = "nearby",
    allow_live: bool = False,
    max_dist_m: float = STATION_MATCH_M,
) -> list[dict[str, Any]]:
    """Find subway stations near the trip start or destination and attach elevator reliability & outages.

    `origin` and `destination` are `(lon, lat)` tuples.
    For `synthetic_demo`, returns a clearly labeled synthetic station example when starting at Demo Library.
    """
    if mode == "synthetic_demo":
        return _synthetic_station_alerts(origin, destination)

    snap = subway_snapshot()
    stations = snap.get("stations") or []
    if not stations:
        return []

    elevators = snap.get("elevators") or []
    avail_rows = snap.get("availability_2026") or []
    outage_rows, outage_source, outage_updated = get_elevator_outages(allow_live=allow_live)

    # Index availability by equipment_code
    avail_by_eq: dict[str, dict[str, Any]] = {}
    for row in avail_rows:
        code = (row.get("equipment_code") or "").strip().upper()
        if code:
            avail_by_eq[code] = row

    # Index active and upcoming outages by equipment_code
    active_outages: dict[str, list[dict[str, Any]]] = {}
    upcoming_outages: dict[str, list[dict[str, Any]]] = {}
    for row in outage_rows:
        if (row.get("equipmenttype") or "EL").upper() != "EL":
            continue
        code = (row.get("equipment") or "").strip().upper()
        if not code:
            continue
        item = {
            "equipment_code": code,
            "station": row.get("station"),
            "trains": row.get("trainno"),
            "serving": row.get("serving"),
            "outage_date": row.get("outagedate"),
            "estimated_return": row.get("estimatedreturntoservice"),
            "reason": row.get("reason"),
            "is_upcoming": (row.get("isupcomingoutage") or "N").upper() == "Y",
            "is_maintenance": (row.get("ismaintenanceoutage") or "N").upper() == "Y",
        }
        if item["is_upcoming"]:
            upcoming_outages.setdefault(code, []).append(item)
        else:
            active_outages.setdefault(code, []).append(item)

    # Index elevators by station_mrn and station_complex_mrn
    by_mrn: dict[str, list[dict[str, Any]]] = {}
    by_complex: dict[str, list[dict[str, Any]]] = {}
    for eq in elevators:
        if (eq.get("elevator_or_escalator") or "").lower() != "elevator":
            continue
        mrn = str(eq.get("station_mrn") or "").strip().lstrip("0")
        cmrn = str(eq.get("station_complex_mrn") or "").strip().lstrip("0")
        if mrn:
            by_mrn.setdefault(mrn, []).append(eq)
        if cmrn:
            by_complex.setdefault(cmrn, []).append(eq)

    results: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()

    for role, (lon, lat) in (("start", origin), ("destination", destination)):
        # Find closest station(s) within max_dist_m
        candidates: list[tuple[float, dict[str, Any]]] = []
        for st in stations:
            try:
                slat = float(st["gtfs_latitude"])
                slon = float(st["gtfs_longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            d = _dist_m(lat, lon, slat, slon)
            if d <= max_dist_m:
                candidates.append((d, st))
        candidates.sort(key=lambda x: x[0])
        if not candidates:
            continue

        # Take closest station Complex or constituent station for this endpoint
        dist_m, st = candidates[0]
        st_id = str(st.get("station_id") or "").strip().lstrip("0")
        complex_id = str(st.get("complex_id") or st_id).strip().lstrip("0")
        dedupe_key = (role, complex_id or st_id)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)

        # Gather all elevators for this station or complex
        eq_map: dict[str, dict[str, Any]] = {}
        for eq in by_mrn.get(st_id, []) + by_complex.get(complex_id, []):
            code = (eq.get("equipment_code") or "").strip().upper()
            if code:
                eq_map[code] = eq

        el_list: list[dict[str, Any]] = []
        active_count = 0
        for code in sorted(eq_map):
            eq = eq_map[code]
            av = avail_by_eq.get(code)
            avail_pct: float | None = None
            tot_outages: int | None = None
            unsched_outages: int | None = None
            months_count: int | None = None
            if av:
                try:
                    ah = float(av.get("available_hours") or 0)
                    th = float(av.get("total_hours") or 0)
                    if th > 0:
                        avail_pct = round((ah / th) * 100.0, 2)
                    tot_outages = int(float(av.get("total_outages") or 0))
                    unsched_outages = int(float(av.get("unscheduled_outages") or 0))
                    months_count = int(float(av.get("months") or 0))
                except (TypeError, ValueError):
                    pass

            cur_outs = active_outages.get(code, [])
            up_outs = upcoming_outages.get(code, [])
            inv_status_code = (eq.get("service_status_code") or "").strip().upper()
            inv_out = inv_status_code in {"RNOS", "OOS"}

            if cur_outs:
                status = "outage"
                active_count += 1
            elif inv_out:
                status = "outage"
                active_count += 1
                cur_outs = [
                    {
                        "equipment_code": code,
                        "station": st.get("stop_name"),
                        "trains": st.get("daytime_routes"),
                        "serving": eq.get("notes") or "Station elevator",
                        "outage_date": None,
                        "estimated_return": None,
                        "reason": eq.get("service_status") or "Out of service in MTA inventory",
                        "is_upcoming": False,
                        "is_maintenance": True,
                    }
                ]
            else:
                status = "in_service"

            el_list.append(
                {
                    "equipment_code": code,
                    "description": eq.get("notes") or eq.get("elevator_direction_serviced") or "Station elevator",
                    "street_access": (eq.get("street_access") or "").upper() == "YES",
                    "ada_compliant": (eq.get("ada_compliant") or "").upper() == "YES",
                    "status": status,
                    "service_status": eq.get("service_status") or "Installed-Functioning-In Service",
                    "alternative_route": eq.get("alternative_route"),
                    "active_outage": cur_outs[0] if cur_outs else None,
                    "upcoming_outages": up_outs[:2],
                    "reliability": {
                        "period": "Jan–Sep 2026",
                        "months_recorded": months_count,
                        "availability_pct": avail_pct,
                        "total_outages": tot_outages,
                        "unscheduled_outages": unsched_outages,
                    }
                    if avail_pct is not None
                    else None,
                }
            )

        # Compute station-wide weighted reliability if elevators have data
        pcts = [e["reliability"]["availability_pct"] for e in el_list if e.get("reliability") and e["reliability"]["availability_pct"] is not None]
        station_avail_pct = round(sum(pcts) / len(pcts), 2) if pcts else None
        station_outages_sum = sum(
            (e["reliability"]["total_outages"] or 0)
            for e in el_list
            if e.get("reliability")
        ) if pcts else None

        results.append(
            {
                "endpoint": role,
                "station_id": st_id,
                "complex_id": complex_id,
                "station_name": st.get("stop_name") or "Subway Station",
                "routes": st.get("daytime_routes") or "",
                "distance_m": round(dist_m, 1),
                "lat": float(st["gtfs_latitude"]),
                "lon": float(st["gtfs_longitude"]),
                "ada_status": _ada_label(st.get("ada")),
                "ada_notes": st.get("ada_notes") if st.get("ada_notes") not in (None, "NaN", "") else None,
                "elevator_count": len(el_list),
                "active_outage_count": active_count,
                "station_availability_pct": station_avail_pct,
                "station_total_outages_2026": station_outages_sum,
                "elevators": el_list,
                "outage_source": outage_source,
                "outage_updated_at": outage_updated,
                "source_url": MTA_STATIONS_PAGE,
            }
        )

    return results


def _synthetic_station_alerts(
    origin: tuple[float, float],
    destination: tuple[float, float],
) -> list[dict[str, Any]]:
    """Deterministic synthetic station alert for synthetic_demo mode."""
    return [
        {
            "endpoint": "start",
            "station_id": "syn-st-1",
            "complex_id": "syn-st-1",
            "station_name": "Demo Main St Station (synthetic)",
            "routes": "7",
            "distance_m": 25.0,
            "lat": origin[1],
            "lon": origin[0],
            "ada_status": "ADA accessible",
            "ada_notes": "Synthetic demonstration station",
            "elevator_count": 2,
            "active_outage_count": 1,
            "station_availability_pct": 98.4,
            "station_total_outages_2026": 6,
            "elevators": [
                {
                    "equipment_code": "EL-SYN1",
                    "description": "Street (Main St & 1st Ave) to mezzanine (fictional)",
                    "street_access": True,
                    "ada_compliant": True,
                    "status": "in_service",
                    "service_status": "Installed-Functioning-In Service",
                    "alternative_route": None,
                    "active_outage": None,
                    "upcoming_outages": [],
                    "reliability": {
                        "period": "Jan–Sep 2026 (synthetic)",
                        "months_recorded": 9,
                        "availability_pct": 99.1,
                        "total_outages": 2,
                        "unscheduled_outages": 1,
                    },
                },
                {
                    "equipment_code": "EL-SYN2",
                    "description": "Mezzanine to platform (fictional)",
                    "street_access": False,
                    "ada_compliant": True,
                    "status": "outage",
                    "service_status": "Under Investigation",
                    "alternative_route": "Use street ramp at West Path entrance (fictional).",
                    "active_outage": {
                        "equipment_code": "EL-SYN2",
                        "station": "Demo Main St Station",
                        "trains": "7",
                        "serving": "Mezzanine to platform",
                        "outage_date": "10/26/2026 08:15:00 AM",
                        "estimated_return": "10/26/2026 11:30:00 PM",
                        "reason": "Maintenance (synthetic example)",
                        "is_upcoming": False,
                        "is_maintenance": True,
                    },
                    "upcoming_outages": [],
                    "reliability": {
                        "period": "Jan–Sep 2026 (synthetic)",
                        "months_recorded": 9,
                        "availability_pct": 97.7,
                        "total_outages": 4,
                        "unscheduled_outages": 3,
                    },
                },
            ],
            "outage_source": "synthetic",
            "outage_updated_at": None,
            "source_url": None,
        }
    ]


def restrooms_within_polygon(polygon_lonlat, *, mode: str = "nearby") -> list[dict[str, Any]]:
    """Return normalized public restrooms inside `polygon_lonlat`."""
    if mode == "synthetic_demo":
        return []
    snap = restrooms_snapshot()
    rows = snap.get("rows") or []
    if not rows or polygon_lonlat is None:
        return []
    area = prep(polygon_lonlat)
    out: list[dict[str, Any]] = []
    for i, r in enumerate(rows):
        try:
            lat = float(r.get("latitude"))
            lon = float(r.get("longitude"))
        except (TypeError, ValueError):
            continue
        if not area.covers(Point(lon, lat)):
            continue
        name = (r.get("facility_name") or "Public restroom").strip()
        status = (r.get("status") or "Unknown").strip()
        out.append(
            {
                "id": f"rr-{i}-{abs(hash((name, round(lat, 5), round(lon, 5)))) % 100000}",
                "name": name,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "location_type": r.get("location_type") or "Public facility",
                "operator": r.get("operator") or None,
                "status": status,
                "operational": status.lower().startswith("operational"),
                "open_season": r.get("open") or None,
                "hours": r.get("hours_of_operation") or None,
                "accessibility": r.get("accessibility") or "Not specified",
                "restroom_type": r.get("restroom_type") or None,
                "changing_stations": r.get("changing_stations") or None,
                "notes": r.get("additional_notes") or None,
                "website": (r.get("website") or {}).get("url") if isinstance(r.get("website"), dict) else r.get("website"),
                "source_url": NYC_RESTROOMS_PAGE,
                "retrieved_at": snap.get("retrieved"),
            }
        )
    out.sort(key=lambda x: (not x["operational"], x["name"]))
    return out


def restrooms_near_route(
    route_coords_lonlat: list[list[float]],
    *,
    mode: str = "nearby",
    max_dist_m: float = 250.0,
) -> list[dict[str, Any]]:
    """Return public restrooms within `max_dist_m` of any point along the planned route."""
    if mode == "synthetic_demo":
        return [
            {
                "id": "rr-syn-1",
                "name": "Back St Garden Comfort Station (synthetic)",
                "lat": 0.0011,
                "lon": 0.0027,
                "location_type": "Park",
                "operator": "Demo Parks Dept",
                "status": "Operational",
                "operational": True,
                "open_season": "Year-round",
                "hours": "8:00 am – 8:00 pm",
                "accessibility": "Fully Accessible",
                "restroom_type": "Multi-stall and single-stall all-gender",
                "changing_stations": "Yes",
                "notes": "Fictional demo restroom record",
                "website": None,
                "source_url": None,
                "retrieved_at": None,
                "distance_from_route_m": 18.0,
            }
        ]
    if not route_coords_lonlat:
        return []
    snap = restrooms_snapshot()
    rows = snap.get("rows") or []
    if not rows:
        return []

    lons = [p[0] for p in route_coords_lonlat]
    lats = [p[1] for p in route_coords_lonlat]
    pad = 0.004  # ~400m
    min_lon, max_lon = min(lons) - pad, max(lons) + pad
    min_lat, max_lat = min(lats) - pad, max(lats) + pad

    # Sample route points every ~5 vertices if very dense, to keep check sub-millisecond
    step = max(1, len(route_coords_lonlat) // 80)
    sampled = route_coords_lonlat[::step]
    if route_coords_lonlat[-1] not in sampled:
        sampled.append(route_coords_lonlat[-1])

    out: list[dict[str, Any]] = []
    for i, r in enumerate(rows):
        try:
            lat = float(r.get("latitude"))
            lon = float(r.get("longitude"))
        except (TypeError, ValueError):
            continue
        if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
            continue
        best_d = min(_dist_m(lat, lon, pt[1], pt[0]) for pt in sampled)
        if best_d <= max_dist_m:
            name = (r.get("facility_name") or "Public restroom").strip()
            status = (r.get("status") or "Unknown").strip()
            out.append(
                {
                    "id": f"rr-{i}-{abs(hash((name, round(lat, 5), round(lon, 5)))) % 100000}",
                    "name": name,
                    "lat": round(lat, 6),
                    "lon": round(lon, 6),
                    "location_type": r.get("location_type") or "Public facility",
                    "operator": r.get("operator") or None,
                    "status": status,
                    "operational": status.lower().startswith("operational"),
                    "open_season": r.get("open") or None,
                    "hours": r.get("hours_of_operation") or None,
                    "accessibility": r.get("accessibility") or "Not specified",
                    "restroom_type": r.get("restroom_type") or None,
                    "changing_stations": r.get("changing_stations") or None,
                    "notes": r.get("additional_notes") or None,
                    "website": (r.get("website") or {}).get("url") if isinstance(r.get("website"), dict) else r.get("website"),
                    "source_url": NYC_RESTROOMS_PAGE,
                    "retrieved_at": snap.get("retrieved"),
                    "distance_from_route_m": round(best_d, 1),
                }
            )
    out.sort(key=lambda x: (not x["operational"], x["distance_from_route_m"], x["name"]))
    return out
