"""HTTP API tests (FastAPI TestClient)."""

import json
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    empty = tmp_path_factory.mktemp("no_pilot")
    return TestClient(create_app(pilot_dir=empty, serve_frontend=False))


@pytest.fixture(scope="module")
def trips(client):
    cfg = client.get("/api/config").json()
    return {t["id"]: t for t in cfg["modes"]["synthetic_demo"]["trips"]}


def body(trip, limit, mode="synthetic_demo", **kw):
    return {
        "origin": {"lat": trip["from"]["lat"], "lon": trip["from"]["lon"]},
        "destination": {"lat": trip["to"]["lat"], "lon": trip["to"]["lon"]},
        "max_gap_m": limit,
        "dataset_mode": mode,
        **kw,
    }


def test_health_and_config(client):
    h = client.get("/api/health").json()
    assert h["modes"] == {"synthetic_demo": "ready", "live_pilot": "data_unavailable"}
    cfg = client.get("/api/config").json()
    assert cfg["slider"] == {"min_m": 50, "max_m": 500, "step_m": 10, "default_m": 150}
    assert cfg["default_mode"] == "nearby"
    assert cfg["modes"]["live_pilot"]["available"] is False
    assert "has not been imported" in cfg["modes"]["live_pilot"]["reason"]
    syn = cfg["modes"]["synthetic_demo"]
    assert syn["network_geojson"]["features"] and len(syn["service_polygon"]) == 5


def test_route_feasible_and_unmet(client, trips):
    r = client.post("/api/route", json=body(trips["slider-demo"], 150, client_request_id="req-7")).json()
    assert r["request_id"] == "req-7" and r["status"] == "ok"
    assert r["total_distance_m"] == pytest.approx(904)
    assert len(r["route_geojson"]["features"]) == len(r["legs"]) == 9
    assert r["comparison_geojson"]["features"][0]["properties"]["distance_m"] == pytest.approx(616)
    r = client.post("/api/route", json=body(trips["slider-demo"], 100)).json()
    assert r["status"] == "limit_unmet" and r["minimum_required_gap_m"] == pytest.approx(136)


def test_every_status_has_a_message(client, trips):
    for t, limit in (("slider-demo", 400), ("slider-demo", 100), ("disconnected", 150), ("direct", 150)):
        r = client.post("/api/route", json=body(trips[t], limit)).json()
        assert r["message"]
    r = client.post("/api/route", json=body(trips["direct"], 150, mode="live_pilot")).json()
    assert r["status"] == "data_unavailable" and r["message"]


def test_no_success_shaped_payload_on_failure(client, trips):
    r = client.post("/api/route", json=body(trips["disconnected"], 150)).json()
    assert r["status"] == "disconnected"
    assert r["route_geojson"] is None and r["total_distance_m"] is None and r["legs"] == []
    r = client.post("/api/route", json=body(trips["direct"], 150, mode="live_pilot")).json()
    assert r["route_geojson"] is None and r["stops"] == []


def test_live_mode_never_falls_back_to_synthetic(client, trips):
    r = client.post("/api/route", json=body(trips["slider-demo"], 150, mode="live_pilot")).json()
    assert r["data_mode"] == "live_pilot" and r["status"] == "data_unavailable"
    s = client.get("/api/seats", params={"bbox": "-1,-1,1,1", "mode": "live_pilot"}).json()
    assert s["status"] == "data_unavailable" and s["seats"] == []


def test_unsupported_area(client, trips):
    b = body(trips["direct"], 150)
    b["destination"] = {"lat": 40.76, "lon": -73.83}
    assert client.post("/api/route", json=b).json()["status"] == "unsupported_area"


@pytest.mark.parametrize(
    "patch",
    [
        {"max_gap_m": 40},
        {"max_gap_m": 501},
        {"origin": {"lat": 91, "lon": 0}},
        {"destination": {"lat": 0, "lon": 200}},
        {"dataset_mode": "other"},
        {"excluded_seat_ids": "not-a-list"},
    ],
)
def test_input_validation(client, trips, patch):
    b = {**body(trips["direct"], 150), **patch}
    assert client.post("/api/route", json=b).status_code == 422


def test_seat_exclusion_via_api(client, trips):
    r1 = client.post("/api/route", json=body(trips["slider-demo"], 400)).json()
    assert [s["id"] for s in r1["stops"]] == ["syn-main-bench"]
    r2 = client.post("/api/route", json=body(trips["slider-demo"], 400, excluded_seat_ids=["syn-main-bench"])).json()
    assert "syn-main-bench" not in [s["id"] for s in r2["stops"]]
    assert r2["total_distance_m"] > r1["total_distance_m"]
    assert [s["number"] for s in r2["stops"]] == list(range(1, r2["rest_count"] + 1))


def test_seats_endpoint(client):
    bad = client.get("/api/seats", params={"bbox": "1,2,3"})
    assert bad.status_code == 422
    assert client.get("/api/seats", params={"bbox": "5,0,1,1"}).status_code == 422
    elig = client.get("/api/seats", params={"bbox": "-1,-1,1,1"}).json()["seats"]
    allseats = client.get("/api/seats", params={"bbox": "-1,-1,1,1", "include_ineligible": True}).json()["seats"]
    assert all(s["routing_eligible"] for s in elig)
    assert len(allseats) > len(elig)
    lean = next(s for s in allseats if s["id"] == "syn-lean-1")
    assert lean["type_label"] == "Leaning bar" and lean["exclusion_reason"]
    assert lean["last_field_verified_at"] is None  # import time is not verification time


def test_places_search(client):
    r = client.get("/api/places", params={"q": "clinic"}).json()
    assert [p["name"] for p in r["places"]] == ["Demo Clinic (synthetic)"]
    assert client.get("/api/places", params={"q": "x" * 65}).status_code == 422


def test_internal_error_is_error_not_infeasible(client, trips):
    planner = client.app.state.rr.planners["synthetic_demo"]
    with mock.patch.object(planner, "plan", side_effect=RuntimeError("boom")):
        resp = client.post("/api/route", json=body(trips["direct"], 150))
    assert resp.status_code == 500 and resp.json()["status"] == "error"
    assert resp.json()["route_geojson"] is None


def test_live_pilot_rejects_mismatched_artifacts(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({"artifacts": {"graph": "g.json.gz", "matrix": "m", "database": "d"}}))
    app = create_app(pilot_dir=tmp_path, serve_frontend=False)
    assert "live_pilot" in app.state.rr.unavailable


def test_hypothetical_seats_via_api(client, trips):
    t = trips["slider-demo"]
    b = body(t, 100)
    lon, lat = client.app.state.rr.datasets["synthetic_demo"].to_lonlat(280, 121)
    b["hypothetical_seats"] = [{"lat": lat, "lon": lon}]
    r = client.post("/api/route", json=b).json()
    assert r["status"] == "ok" and r["hypothetical"]["without"]["status"] == "limit_unmet"
    b["hypothetical_seats"] = [{"lat": lat, "lon": lon}] * 4
    assert client.post("/api/route", json=b).status_code == 422


def test_station_elevators_and_nearby_restrooms_in_route(client, trips):
    r = client.post("/api/route", json=body(trips["slider-demo"], 150)).json()
    assert r["status"] == "ok"
    assert len(r["station_elevators"]) >= 1
    st = r["station_elevators"][0]
    assert st["station_name"] == "Demo Main St Station (synthetic)"
    assert st["active_outage_count"] == 1
    assert any(e["status"] == "outage" and e["reliability"]["availability_pct"] == 97.7 for e in st["elevators"])
    assert len(r["nearby_restrooms"]) >= 1
    assert r["nearby_restrooms"][0]["name"] == "Back St Garden Comfort Station (synthetic)"


def test_flushing_route_returns_real_station_elevator_and_restrooms(client):
    cfg = client.get("/api/config").json()["modes"]["nearby"]
    trip = cfg["trips"][0]
    area = client.post("/api/areas", json={"origin": trip["from"], "destination": trip["to"]}).json()
    assert area["status"] == "ready"
    assert len(area.get("restrooms", [])) >= 1
    # Verify ineligible leaning bars or shelters are also returned for map display
    assert any(not s["routing_eligible"] for s in area["seats"])
    r = client.post(
        "/api/route",
        json={
            "origin": trip["from"],
            "destination": trip["to"],
            "max_gap_m": 400,
            "dataset_mode": "nearby",
            "dataset_id": area["dataset_id"],
        },
    ).json()
    assert r["status"] == "ok"
    assert any("Flushing" in s["station_name"] for s in r["station_elevators"])
    flushing_st = next(s for s in r["station_elevators"] if "Flushing" in s["station_name"])
    assert any(e["equipment_code"] == "EL414" and e["reliability"]["availability_pct"] > 95 for e in flushing_st["elevators"])
    assert len(r["nearby_restrooms"]) >= 1
