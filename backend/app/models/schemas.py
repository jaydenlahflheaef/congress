"""Request/response models for the HTTP API (Pydantic)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SLIDER_MIN_M = 50
SLIDER_MAX_M = 500
SLIDER_STEP_M = 10
SLIDER_DEFAULT_M = 150

DatasetMode = Literal["live_pilot", "synthetic_demo"]
RouteStatus = Literal[
    "ok",
    "limit_unmet",
    "disconnected",
    "unsupported_area",
    "data_unavailable",
    "endpoint_unresolved",
    "error",
]


class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class RouteRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    max_gap_m: float = Field(ge=SLIDER_MIN_M, le=SLIDER_MAX_M)
    excluded_seat_ids: list[str] = Field(default_factory=list, max_length=500)
    dataset_mode: DatasetMode = "synthetic_demo"
    client_request_id: str | None = Field(default=None, max_length=64)
    # Optional planning experiment: up to 3 hypothetical benches, never stored.
    hypothetical_seats: list[LatLon] = Field(default_factory=list, max_length=3)


class Leg(BaseModel):
    index: int
    from_id: str
    to_id: str
    from_label: str
    to_label: str
    distance_m: float
    over_limit: bool
    exceeds_by_m: float


class RouteResponse(BaseModel):
    request_id: str
    status: RouteStatus
    message: str
    dataset_version: str | None
    data_mode: DatasetMode
    coverage: dict | None = None
    requested_max_gap_m: float
    total_distance_m: float | None = None
    longest_gap_m: float | None = None
    minimum_required_gap_m: float | None = None
    rest_count: int | None = None
    extra_distance_m: float | None = None
    comparison_distance_m: float | None = None
    route_geojson: dict | None = None
    comparison_geojson: dict | None = None
    stops: list[dict] = Field(default_factory=list)
    legs: list[Leg] = Field(default_factory=list)
    over_limit_legs: list[int] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    snapped_endpoints: dict | None = None
    limitation_note: str | None = None
    timing_ms: float | None = None
    endpoint_cache_hit: bool | None = None
    seats_considered: int | None = None
    hypothetical: dict | None = None
