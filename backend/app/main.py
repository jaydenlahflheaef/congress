"""FastAPI application.

Run for development:  uvicorn app.main:app --reload   (from backend/)

Prepared datasets load at startup; new nearby areas load in a background worker.
Route requests only touch in-memory data,
so dragging the slider never calls OpenStreetMap, NYC Open Data or any
outside routing service. Request bodies (which contain trip endpoints) are
never logged.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .data.dataset import DEFAULT_PILOT_DIR, REPO_ROOT, DataUnavailable, Dataset, load_live, load_synthetic
from .data.nearby import NOT_LOADED, NearbyAreas, load_seeds
from .data.nyc import nyc_region
from .data.geocoder import search_places
from .models.schemas import (
    AreaRequest,
    SLIDER_DEFAULT_M,
    SLIDER_MAX_M,
    SLIDER_MIN_M,
    SLIDER_STEP_M,
    RouteRequest,
    RouteResponse,
)
from .routing.planner import LIMITATION_NOTE, Planner

log = logging.getLogger("rest_route")
# The Home Screen app manifest; Python does not know this extension on every system.
mimetypes.add_type("application/manifest+json", ".webmanifest")


class State:
    def __init__(self, pilot_dir: Path, load_live_data: bool = True):
        self.datasets: dict[str, Dataset] = {}
        self.unavailable: dict[str, str] = {}
        self.planners: dict[str, Planner] = {}
        self.nearby = NearbyAreas(region=nyc_region(), fixed=load_seeds())
        syn = load_synthetic()
        self.datasets["synthetic_demo"] = syn
        self.planners["synthetic_demo"] = Planner(syn)
        if load_live_data:
            try:
                live = load_live(pilot_dir)
                self.datasets["live_pilot"] = live
                self.planners["live_pilot"] = Planner(live)
            except DataUnavailable as e:
                self.unavailable["live_pilot"] = str(e)
        else:
            self.unavailable["live_pilot"] = "Live pilot loading disabled for this server."


def create_app(pilot_dir: Path | None = None, *, load_live_data: bool = True, serve_frontend: bool = True) -> FastAPI:
    pilot_dir = Path(pilot_dir or os.environ.get("REST_ROUTE_PILOT_DIR", DEFAULT_PILOT_DIR))
    app = FastAPI(title="Rest Route API", version="0.1.0")
    state = State(pilot_dir, load_live_data)
    app.state.rr = state

    def get_ds(mode: str) -> Dataset | None:
        return state.datasets.get(mode)

    def check_mode(mode: str) -> None:
        if mode not in ("synthetic_demo", "live_pilot"):
            raise HTTPException(422, "mode must be synthetic_demo or live_pilot")

    @app.get("/api/health")
    def health():
        modes = {m: "ready" for m in state.datasets}
        modes.update({m: "data_unavailable" for m in state.unavailable})
        return {"status": "ok", "modes": modes}

    @app.get("/api/config")
    def config():
        modes = {}
        for m in ("live_pilot", "synthetic_demo"):
            ds = get_ds(m)
            if ds is None:
                modes[m] = {"mode": m, "available": False, "status": "data_unavailable", "reason": state.unavailable.get(m)}
            else:
                c = ds.public_config()
                if ds.network_geojson is not None:
                    c["network_geojson"] = ds.network_geojson
                modes[m] = c
        modes["nearby"] = {
            "mode": "nearby",
            "available": True,
            "area_name": nyc_region().name,
            "basemap_default": True,
            "region_bounds": list(nyc_region().bbox),
            # Example walks inside the prepared areas, which open instantly.
            "trips": [t for p in state.nearby.fixed.values() for t in p.ds.trips],
        }
        return {
            "slider": {"min_m": SLIDER_MIN_M, "max_m": SLIDER_MAX_M, "step_m": SLIDER_STEP_M, "default_m": SLIDER_DEFAULT_M},
            "modes": modes,
            "default_mode": "nearby",
            "limitation_note": LIMITATION_NOTE,
        }

    @app.post("/api/areas")
    def prepare_area(req: AreaRequest):
        try:
            return state.nearby.prepare(req.origin, req.destination)
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.get("/api/areas/{dataset_id}")
    def area_status(dataset_id: str):
        return state.nearby.status(dataset_id)

    @app.get("/api/search")
    def place_search(q: str = Query(..., min_length=3, max_length=200)):
        try:
            return {"status": "ok", "places": search_places(q)}
        except Exception:
            return JSONResponse(status_code=503, content={"detail": "Place search is unavailable. Try again or choose a point on the map."})

    @app.get("/api/seats")
    def seats(
        bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat"),
        mode: str = "synthetic_demo",
        include_ineligible: bool = False,
    ):
        check_mode(mode)
        try:
            min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox must be four numbers: minLon,minLat,maxLon,maxLat")
        if not (-180 <= min_lon < max_lon <= 180 and -90 <= min_lat < max_lat <= 90):
            raise HTTPException(422, "bbox coordinates out of range or min >= max")
        ds = get_ds(mode)
        if ds is None:
            return {"status": "data_unavailable", "message": state.unavailable.get(mode), "seats": []}
        out = [
            s.to_public()
            for s in ds.seats.values()
            if min_lon <= s.lon <= max_lon
            and min_lat <= s.lat <= max_lat
            and (include_ineligible or s.routing_eligible)
        ]
        return {"status": "ok", "dataset_version": ds.version, "seats": out}

    @app.get("/api/places")
    def places(q: str = Query("", max_length=64), mode: str = "synthetic_demo"):
        check_mode(mode)
        ds = get_ds(mode)
        if ds is None:
            return {"status": "data_unavailable", "message": state.unavailable.get(mode), "places": []}
        ql = q.strip().lower()
        hits = [p for p in ds.places if ql in p["name"].lower()] if ql else list(ds.places)
        hits.sort(key=lambda p: (not p["name"].lower().startswith(ql), p["name"]))
        return {"status": "ok", "places": hits[:10]}

    @app.post("/api/route", response_model=RouteResponse)
    def route(req: RouteRequest):
        rid = req.client_request_id or uuid.uuid4().hex
        planner = state.nearby.get_planner(req.dataset_id) if req.dataset_mode == "nearby" else state.planners.get(req.dataset_mode)
        if planner is None:
            return RouteResponse(
                request_id=rid,
                status="data_unavailable",
                message=state.unavailable.get(req.dataset_mode, NOT_LOADED),
                dataset_version=None,
                data_mode=req.dataset_mode,
                requested_max_gap_m=req.max_gap_m,
                limitation_note=LIMITATION_NOTE,
            )
        try:
            res = planner.plan(
                (req.origin.lon, req.origin.lat),
                (req.destination.lon, req.destination.lat),
                req.max_gap_m,
                req.excluded_seat_ids,
                request_id=rid,
                hypothetical=[(h.lon, h.lat) for h in req.hypothetical_seats],
            )
            return RouteResponse(**res)
        except Exception:  # noqa: BLE001 - report as an error, never as "no route"
            log.exception("route computation failed (endpoints not logged)")
            return JSONResponse(
                status_code=500,
                content=RouteResponse(
                    request_id=rid,
                    status="error",
                    message="Something went wrong while computing the route. This is a software error, not a finding about seats.",
                    dataset_version=planner.ds.version,
                    data_mode=req.dataset_mode,
                    requested_max_gap_m=req.max_gap_m,
                ).model_dump(),
            )

    dist = REPO_ROOT / "frontend" / "dist"
    if serve_frontend and (dist / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = (dist / path).resolve()
            if path and f.is_file() and dist.resolve() in f.parents:
                return FileResponse(f)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
