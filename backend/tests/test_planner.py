"""End-to-end planner tests on small hand-built datasets and the demo fixture.

Coordinates are meters in a local projection, so expected distances can be
worked out by hand.
"""

import pytest

from app.data.dataset import build_synthetic, load_synthetic
from app.routing.planner import Planner


def plan(ds, a, b, limit, excluded=()):
    to_ll = ds.to_lonlat
    return Planner(ds).plan(to_ll(*a), to_ll(*b), limit, list(excluded))


def line_world(seats, extra_nodes=None, extra_segments=None):
    """A straight 600 m street from (0,0) to (600,0) plus optional extras."""
    nodes = {"A": [0, 0], "B": [600, 0], **(extra_nodes or {})}
    segments = [{"id": "street", "a": "A", "b": "B"}] + (extra_segments or [])
    return build_synthetic({"nodes": nodes, "segments": segments, "seats": seats})


def bench(sid, x, y, **kw):
    return {"id": sid, "x": x, "y": y, "type": "bench", **kw}


def test_direct_trip_without_benches():
    ds = line_world([])
    r = plan(ds, (0, -5), (100, -5), 150)
    assert r["status"] == "ok" and r["rest_count"] == 0
    assert r["total_distance_m"] == pytest.approx(110.0)  # 5 + 100 + 5 connectors
    assert r["extra_distance_m"] == pytest.approx(0.0)


def test_exactly_on_threshold_leg_is_accepted():
    ds = line_world([])
    r = plan(ds, (0, -5), (140, -5), 150)  # 5 + 140 + 5 = 150 exactly
    assert r["status"] == "ok" and r["longest_gap_m"] == pytest.approx(150.0)
    r = plan(ds, (0, -5), (140, -5), 149.99)
    assert r["status"] == "limit_unmet"


def test_longer_route_through_seats_beats_shorter_violating_route():
    # Street A-B is 600 m with no seats; a loop via C has seats.
    seats = [bench("s1", 150, 203), bench("s2", 300, 203), bench("s3", 450, 203)]
    ds = line_world(
        seats,
        extra_nodes={"C": [0, 200], "D": [600, 200]},
        extra_segments=[
            {"id": "west", "a": "A", "b": "C"},
            {"id": "north", "a": "C", "b": "D"},
            {"id": "east", "a": "D", "b": "B"},
        ],
    )
    r = plan(ds, (0, 0), (600, 0), 400)
    assert r["status"] == "ok"
    assert [s["id"] for s in r["stops"]] == ["s1", "s3"]
    assert r["total_distance_m"] == pytest.approx(200 + 600 + 200 + 4 * 3)
    assert r["comparison_distance_m"] == pytest.approx(600)


def test_first_or_last_leg_too_long_is_reported():
    seats = [bench("mid", 300, -3)]
    ds = line_world(seats)
    r = plan(ds, (0, 0), (600, 0), 250)
    assert r["status"] == "limit_unmet"
    assert r["minimum_required_gap_m"] == pytest.approx(303)
    assert r["over_limit_legs"] == [1, 2]
    r = plan(ds, (250, 0), (600, 0), 310)  # first leg 53, last leg 303
    assert r["status"] == "ok" and r["rest_count"] == 1
    r = plan(ds, (250, 0), (600, 0), 300)
    assert r["status"] == "limit_unmet" and r["over_limit_legs"] == [2]


def test_bench_close_but_unreachable_is_not_used():
    ds = line_world(
        [bench("island", 300, 40)],
        extra_nodes={"I1": [250, 43], "I2": [350, 43]},
        extra_segments=[{"id": "island-path", "a": "I1", "b": "I2"}],
    )
    assert ds.seats["island"].routing_eligible  # attaches to the island path
    r = plan(ds, (0, 0), (600, 0), 400)
    assert r["status"] == "limit_unmet"
    assert r["rest_count"] == 0 and r["minimum_required_gap_m"] == pytest.approx(600)


def test_minimax_fallback_values():
    seats = [bench("s1", 200, -3), bench("s2", 330, -3)]
    ds = line_world(seats)
    r = plan(ds, (0, 0), (600, 0), 100)
    # Best possible: 0->200 (203), 200->330 (136), 330->600 (273): bottleneck 273
    assert r["status"] == "limit_unmet"
    assert r["minimum_required_gap_m"] == pytest.approx(273)
    assert r["longest_gap_m"] == pytest.approx(273)
    # Start->s2 directly would be 333 m (> 273), so the route must use both seats.
    assert [s["id"] for s in r["stops"]] == ["s1", "s2"]


def test_equal_bottleneck_chooses_shorter_total():
    # Route 1: Main street via seat a, legs 303 + 303 = 606.
    # Route 2: North loop via n1, n2, legs 303 + 206 + 303 = 812.
    # Both have longest leg 303 (the best possible), so the shorter one wins.
    seats = [bench("a", 300, -3), bench("n1", 200, 103), bench("n2", 400, 103)]
    ds = line_world(
        seats,
        extra_nodes={"C": [0, 100], "D": [600, 100]},
        extra_segments=[
            {"id": "w", "a": "A", "b": "C"},
            {"id": "n", "a": "C", "b": "D"},
            {"id": "e", "a": "D", "b": "B"},
        ],
    )
    r = plan(ds, (0, 0), (600, 0), 100)
    assert r["status"] == "limit_unmet"
    assert r["minimum_required_gap_m"] == pytest.approx(303)
    assert [s["id"] for s in r["stops"]] == ["a"]
    assert r["total_distance_m"] == pytest.approx(606)


def test_seat_exclusion_changes_route_and_feasibility():
    seats = [bench("s1", 200, -3), bench("s2", 400, -3)]
    ds = line_world(seats)
    r = plan(ds, (0, 0), (600, 0), 210)
    assert r["status"] == "ok" and r["rest_count"] == 2
    r = plan(ds, (0, 0), (600, 0), 210, excluded=["s2"])
    assert r["status"] == "limit_unmet"
    assert r["minimum_required_gap_m"] == pytest.approx(403)
    assert any("excluded by you" in w for w in r["warnings"])


def test_directed_network_distances_differ_by_direction():
    # One-way path A->B along the street (y=0); return trip must use the loop.
    ds = build_synthetic(
        {
            "nodes": {"A": [0, 0], "B": [300, 0], "C": [300, 100], "D": [0, 100]},
            "segments": [
                {"id": "oneway", "a": "A", "b": "B", "forward": True, "backward": False},
                {"id": "bc", "a": "B", "b": "C"},
                {"id": "cd", "a": "C", "b": "D"},
                {"id": "da", "a": "D", "b": "A"},
            ],
            "seats": [],
        }
    )
    go = plan(ds, (0, 0), (300, 0), 500)
    back = plan(ds, (300, 0), (0, 0), 500)
    assert go["total_distance_m"] == pytest.approx(300)
    assert back["total_distance_m"] == pytest.approx(500)


def test_route_geometry_follows_parallel_curved_edge():
    ds = build_synthetic(
        {
            "nodes": {"A": [0, 0], "B": [200, 0]},
            "segments": [
                {"id": "curve", "a": "A", "b": "B", "xy": [[0, 0], [100, 75], [200, 0]]},
                {"id": "blocked", "a": "A", "b": "B", "forward": False, "backward": True},
            ],
            "seats": [],
        }
    )
    r = plan(ds, (0, 0), (200, 0), 500)
    assert r["total_distance_m"] == pytest.approx(250)
    coords = r["route_geojson"]["features"][0]["geometry"]["coordinates"]
    assert len(coords) >= 3  # bends through the curve's middle vertex, not a straight line


def test_meter_units_connectors_and_totals():
    ds = line_world([bench("s", 300, -12)])
    r = plan(ds, (0, -7), (600, -9), 400)
    assert ds.seats["s"].attachment_metadata["connector_m"] == pytest.approx(12)
    assert [leg["distance_m"] for leg in r["legs"]] == [pytest.approx(7 + 300 + 12), pytest.approx(12 + 300 + 9)]
    assert r["total_distance_m"] == pytest.approx(sum(leg["distance_m"] for leg in r["legs"]))
    assert r["snapped_endpoints"]["origin"]["snap_distance_m"] == pytest.approx(7)


def test_ineligible_seat_types_and_rules():
    seats = [
        {"id": "lean", "x": 300, "y": -3, "type": "leaning_bar"},
        {"id": "shelter", "x": 310, "y": -3, "type": "shelter_unknown_seating"},
        {"id": "unknown", "x": 320, "y": -3, "type": "unknown"},
        bench("private", 330, -3, public_access="no"),
        bench("hours", 340, -3, opening_hours="Mo-Fr 08:00-18:00"),
        bench("gone", 350, -3, availability_status="unavailable"),
        bench("far", 300, -80),
    ]
    ds = line_world(seats)
    assert not any(s.routing_eligible for s in ds.seats.values())
    assert "No mapped walkway" in ds.seats["far"].exclusion_reason
    r = plan(ds, (0, 0), (600, 0), 400)
    assert r["status"] == "limit_unmet" and r["rest_count"] == 0


def test_cross_road_duplicates_not_merged_but_same_side_are():
    # "north" is only 4.5 m from "south" (within the merge distance) but on the
    # other side of the street, so it must stay a separate seat.
    seats = [bench("south", 300, -3), bench("south-dup", 301, -3.5), bench("north", 300, 1.5)]
    ds = line_world(seats)
    assert "south-dup" not in ds.seats
    assert ds.seats["south"].seat_count == 2
    assert "north" in ds.seats and ds.seats["north"].routing_eligible


def test_unsupported_area_and_unresolved_endpoint():
    ds = build_synthetic(
        {
            "nodes": {"A": [0, 0], "B": [600, 0]},
            "segments": [{"id": "s", "a": "A", "b": "B"}],
            "seats": [],
            "service_polygon_xy": [[-100, -200], [700, -200], [700, 200], [-100, 200], [-100, -200]],
        }
    )
    assert plan(ds, (0, 0), (900, 0), 200)["status"] == "unsupported_area"
    r = plan(ds, (0, 0), (300, 150), 200)
    assert r["status"] == "endpoint_unresolved" and r["route_geojson"] is None


def test_identical_points_zero_route():
    ds = line_world([])
    r = plan(ds, (100, -2), (100, -2), 150)
    assert r["status"] == "ok" and r["total_distance_m"] == 0


# ---- demo fixture scenarios -------------------------------------------------

@pytest.fixture(scope="module")
def demo():
    return load_synthetic()


def trip(ds, trip_id):
    t = next(t for t in ds.trips if t["id"] == trip_id)
    return (t["from"]["lon"], t["from"]["lat"]), (t["to"]["lon"], t["to"]["lat"])


def test_demo_400_uses_main_street(demo):
    a, b = trip(demo, "slider-demo")
    r = Planner(demo).plan(a, b, 400, [])
    assert r["status"] == "ok"
    assert r["total_distance_m"] == pytest.approx(622, abs=1e-6)
    assert [s["id"] for s in r["stops"]] == ["syn-main-bench"]


def test_demo_150_detours_through_back_street(demo):
    a, b = trip(demo, "slider-demo")
    r = Planner(demo).plan(a, b, 150, [])
    assert r["status"] == "ok"
    assert r["total_distance_m"] == pytest.approx(904, abs=1e-6)
    assert r["longest_gap_m"] == pytest.approx(136, abs=1e-6)
    assert r["extra_distance_m"] == pytest.approx(288, abs=1e-6)
    assert r["rest_count"] == 8


def test_demo_100_cannot_be_met(demo):
    a, b = trip(demo, "slider-demo")
    r = Planner(demo).plan(a, b, 100, [])
    assert r["status"] == "limit_unmet"
    assert r["minimum_required_gap_m"] == pytest.approx(136, abs=1e-6)
    assert r["over_limit_legs"] == [5, 9]
    assert "smallest achievable longest gap is 136 m" in r["message"]


def test_demo_disconnected_and_direct(demo):
    a, b = trip(demo, "disconnected")
    assert Planner(demo).plan(a, b, 150, [])["status"] == "disconnected"
    a, b = trip(demo, "direct")
    r = Planner(demo).plan(a, b, 150, [])
    assert r["status"] == "ok" and r["rest_count"] == 0 and r["total_distance_m"] == pytest.approx(136)


def test_demo_leaning_bars_do_not_count(demo):
    assert demo.seats["syn-lean-1"].routing_eligible is False
    assert "Leaning bar" in demo.seats["syn-lean-1"].exclusion_reason


def test_demo_redraw_matches_planned_distance(demo):
    a, b = trip(demo, "slider-demo")
    for limit in (500, 300, 150, 100):
        r = Planner(demo).plan(a, b, limit, [])
        assert not any("Internal check" in w for w in r["warnings"])


# ---- optional phase: hypothetical benches -----------------------------------

def test_hypothetical_bench_fixes_gap_and_matches_real_bench():
    ds = line_world([])
    to_ll = ds.to_lonlat
    p = Planner(ds)
    r = p.plan(to_ll(0, 0), to_ll(600, 0), 310, [], hypothetical=[to_ll(300, 4)])
    assert r["status"] == "ok"
    assert [s["id"] for s in r["stops"]] == ["@hyp1"] and r["stops"][0]["hypothetical"]
    assert [leg["distance_m"] for leg in r["legs"]] == [pytest.approx(300), pytest.approx(300)]
    assert r["legs"][0]["to_label"] == "Hypothetical bench 1"
    w = r["hypothetical"]["without"]
    assert w["status"] == "limit_unmet" and w["minimum_required_gap_m"] == pytest.approx(600)
    assert r["hypothetical"]["benches"][0]["moved_m"] == pytest.approx(4)
    # same answer as a real bench at that spot with no connector
    real = line_world([bench("real", 300, 0)])
    rr = plan(real, (0, 0), (600, 0), 310)
    assert rr["total_distance_m"] == pytest.approx(r["total_distance_m"])
    # nothing was added to the dataset
    assert "@hyp1" not in ds.seats and "@hyp1" not in ds.seat_node


def test_hypothetical_bench_matches_real_bench_on_demo_fixture():
    demo = load_synthetic()
    to_ll = demo.to_lonlat
    a, b = to_ll(0, -8), to_ll(600, -8)
    r = Planner(demo).plan(a, b, 100, [], hypothetical=[to_ll(280, 121)])
    assert r["status"] == "ok"
    assert "@hyp1" in r["hypothetical"]["used"]
    assert r["hypothetical"]["without"]["minimum_required_gap_m"] == pytest.approx(136)
    assert r["longest_gap_m"] <= 100
    assert not any("Internal check" in wmsg for wmsg in r["warnings"])


def test_hypothetical_bench_off_walkway_is_ignored_with_warning():
    ds = line_world([])
    r = Planner(ds).plan(ds.to_lonlat(0, 0), ds.to_lonlat(600, 0), 310, [], hypothetical=[ds.to_lonlat(300, 50)])
    assert r["hypothetical"] is None and r["status"] == "limit_unmet"
    assert any("Hypothetical bench 1 ignored" in w for w in r["warnings"])


def test_two_hypothetical_benches_and_between_them():
    ds = line_world([])
    to_ll = ds.to_lonlat
    r = Planner(ds).plan(to_ll(0, 0), to_ll(600, 0), 200, [], hypothetical=[to_ll(200, 0), to_ll(400, 0)])
    assert r["status"] == "ok" and r["rest_count"] == 2
    assert [leg["distance_m"] for leg in r["legs"]] == [pytest.approx(200)] * 3
