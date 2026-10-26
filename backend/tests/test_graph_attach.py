"""Walking-graph primitives: Dijkstra, direction, parallel edges, splitting."""

import math
import random

import networkx as nx
import pytest

from app.routing.attach import SegmentIndex, choose_attachment, split_segments, sub_polyline
from app.routing.graph import PedGraph, Segment, polyline_length


def seg(g, sid, a, b, *, xy=None, fwd=True, bwd=True):
    xy = xy or [g.nodes[a], g.nodes[b]]
    g.add_segment(Segment(sid, a, b, xy, polyline_length(xy), fwd, bwd))


@pytest.mark.parametrize("seed", range(25))
def test_dijkstra_matches_networkx(seed):
    rng = random.Random(seed)
    g = PedGraph("EPSG:32618")
    G = nx.MultiDiGraph()
    n = rng.randint(2, 25)
    for i in range(n):
        g.add_node(f"n{i}", (rng.uniform(0, 500), rng.uniform(0, 500)))
        G.add_node(f"n{i}")
    for k in range(rng.randint(1, 60)):
        a, b = rng.sample(range(n), 2)
        fwd, bwd = rng.choice([(True, True), (True, False), (False, True)])
        sid = f"e{k}"
        seg(g, sid, f"n{a}", f"n{b}", fwd=fwd, bwd=bwd)
        L = g.segments[sid].length_m
        if fwd:
            G.add_edge(f"n{a}", f"n{b}", key=sid, length=L)
        if bwd:
            G.add_edge(f"n{b}", f"n{a}", key=sid, length=L)
    dist, _ = g.dijkstra({"n0": 0.0})
    want = nx.single_source_dijkstra_path_length(G, "n0", weight="length")
    assert set(dist) == set(want)
    for k, v in want.items():
        assert dist[k] == pytest.approx(v, abs=1e-9)
    rdist, _ = g.dijkstra({"n0": 0.0}, reverse=True)
    rwant = nx.single_source_dijkstra_path_length(G.reverse(copy=True), "n0", weight="length")
    assert set(rdist) == set(rwant)


def test_one_way_segment_gives_asymmetric_distances():
    g = PedGraph("EPSG:32618")
    for nid, xy in {"a": (0, 0), "b": (100, 0), "c": (100, 100)}.items():
        g.add_node(nid, xy)
    seg(g, "ab", "a", "b", fwd=True, bwd=False)  # one-way a -> b
    seg(g, "bc", "b", "c")
    seg(g, "ca", "c", "a")
    d_ab = g.dijkstra({"a": 0.0})[0]["b"]
    d_ba = g.dijkstra({"b": 0.0})[0]["a"]
    assert d_ab == pytest.approx(100.0)
    assert d_ba == pytest.approx(100.0 + math.hypot(100, 100))


def test_parallel_edges_keep_identity_and_geometry():
    g = PedGraph("EPSG:32618")
    g.add_node("a", (0, 0))
    g.add_node("b", (100, 0))
    seg(g, "straight", "a", "b")
    seg(g, "arc", "a", "b", xy=[(0, 0), (50, 40), (100, 0)])
    dist, pred = g.dijkstra({"a": 0.0})
    assert dist["b"] == pytest.approx(100.0)
    assert pred["b"].seg_id == "straight"
    g.remove_segment("straight")
    dist, pred = g.dijkstra({"a": 0.0})
    assert pred["b"].seg_id == "arc"
    assert dist["b"] == pytest.approx(2 * math.hypot(50, 40))
    assert g.step_xy(pred["b"]) == [(0, 0), (50, 40), (100, 0)]


def test_split_preserves_length_direction_geometry():
    g = PedGraph("EPSG:32618")
    g.add_node("a", (0, 0))
    g.add_node("b", (100, 100))
    seg(g, "bent", "a", "b", xy=[(0, 0), (100, 0), (100, 100)], fwd=True, bwd=False)
    idx = SegmentIndex(g)
    atts = {
        "p": choose_attachment(g, idx, (50, -3), max_dist_m=20),
        "q": choose_attachment(g, idx, (103, 50), max_dist_m=20),
        "r": choose_attachment(g, idx, (50.001, -3), max_dist_m=20),  # same spot as p
    }
    nodes = split_segments(g, atts)
    assert nodes["p"] == nodes["r"]
    pieces = [s for s in g.segments.values()]
    assert sum(s.length_m for s in pieces) == pytest.approx(200.0, abs=1e-9)
    assert all(s.forward and not s.backward for s in pieces)
    d = g.dijkstra({"a": 0.0})[0]
    assert d[nodes["p"]] == pytest.approx(50.0)
    assert d[nodes["q"]] == pytest.approx(150.0)
    assert "a" not in g.dijkstra({nodes["q"]: 0.0})[0]  # one-way kept after splitting


def test_attachment_ambiguous_across_unconnected_sidewalks():
    # Two parallel sidewalks 10 m apart, joined only 300 m away.
    g = PedGraph("EPSG:32618")
    for nid, xy in {"n1": (0, 0), "n2": (300, 0), "s1": (0, 10), "s2": (300, 10)}.items():
        g.add_node(nid, xy)
    seg(g, "north", "s1", "s2")
    seg(g, "south", "n1", "n2")
    seg(g, "link", "n2", "s2")
    idx = SegmentIndex(g)
    mid = choose_attachment(g, idx, (100, 5), max_dist_m=20)
    assert mid.ambiguous
    near_south = choose_attachment(g, idx, (100, 1), max_dist_m=20)
    assert not near_south.ambiguous and near_south.seg_id == "south"
    assert choose_attachment(g, idx, (100, 60), max_dist_m=20) is None


def test_sub_polyline_reverse_and_units():
    xy = [(0, 0), (30, 40), (30, 100)]
    assert polyline_length(xy) == pytest.approx(110.0)
    part = sub_polyline(xy, 25, 80)
    assert polyline_length(part) == pytest.approx(55.0)
    assert sub_polyline(xy, 80, 25) == list(reversed(part))
