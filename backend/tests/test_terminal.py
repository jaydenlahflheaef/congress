"""Terminal-graph search tests, including a brute-force oracle.

For small random graphs we enumerate every simple path from start to
destination and compute the right answers directly, then compare with the
Dijkstra-based searches. Weights are exact integers, so no tolerance is
needed.
"""

import random

import pytest

from app.routing.terminal import minimax_gap, shortest_within_limit, to_um, two_pass_fallback


def simple_paths(arcs, src, dst):
    out = []

    def rec(u, seen, path, weights):
        if u == dst:
            out.append((list(path), list(weights)))
            return
        for v, w in arcs.get(u, ()):
            if v in seen:
                continue
            seen.add(v)
            path.append(v)
            weights.append(w)
            rec(v, seen, path, weights)
            path.pop()
            weights.pop()
            seen.discard(v)

    rec(src, {src}, [src], [])
    return out


def random_arcs(rng, n_seats, p_arc, max_w):
    nodes = ["O"] + [f"s{i}" for i in range(n_seats)] + ["D"]
    arcs = {u: [] for u in nodes}
    for u in nodes:
        for v in nodes:
            if u == v or u == "D" or v == "O":
                continue
            if rng.random() < p_arc:
                arcs[u].append((v, rng.randint(0, max_w)))
    return arcs


def oracle(arcs, limit):
    paths = simple_paths(arcs, "O", "D")
    if not paths:
        return None
    feas = [sum(w) for p, w in paths if max(w, default=0) <= limit]
    best_feasible = min(feas) if feas else None
    b_star = min(max(w, default=0) for _, w in paths)
    best_at_b = min(sum(w) for _, w in paths if max(w, default=0) <= b_star)
    return best_feasible, b_star, best_at_b


@pytest.mark.parametrize("seed", range(300))
def test_matches_bruteforce_oracle(seed):
    rng = random.Random(seed)
    arcs = random_arcs(rng, rng.randint(0, 6), rng.choice([0.2, 0.4, 0.7]), rng.choice([5, 20, 400]))
    limit = rng.randint(0, 400)
    want = oracle(arcs, limit)
    got_a = shortest_within_limit(arcs, "O", "D", limit)
    got_b = two_pass_fallback(arcs, "O", "D")
    if want is None:
        assert got_a is None and got_b is None
        return
    best_feasible, b_star, best_at_b = want
    if best_feasible is None:
        assert got_a is None
    else:
        total, path = got_a
        assert total == best_feasible
        ws = dict(((u, v), w) for u in arcs for v, w in arcs[u])
        legs = [ws[(path[i], path[i + 1])] for i in range(len(path) - 1)]
        assert sum(legs) == total and max(legs, default=0) <= limit
    bb, tot, path = got_b
    assert bb == b_star
    assert tot == best_at_b
    assert minimax_gap(arcs, "O", "D") == b_star


def test_single_label_lexicographic_minimax_is_wrong_but_two_pass_is_right():
    # Two prefixes reach X: O->X (bottleneck 5, total 5) and O->Y->X
    # (bottleneck 3, total 6). Keeping only the better-bottleneck label at X
    # keeps the second prefix. Then X->D has weight 10, which erases the
    # bottleneck difference: both full routes have bottleneck 10, and the
    # first is shorter (15 vs 16).
    arcs = {"O": [("X", 5), ("Y", 3)], "Y": [("X", 3)], "X": [("D", 10)], "D": []}

    def naive_single_label(arcs, src, dst):
        import heapq

        best = {src: (0, 0)}
        heap = [(0, 0, src)]
        done = set()
        while heap:
            b, t, u = heapq.heappop(heap)
            if u in done:
                continue
            done.add(u)
            for v, w in arcs.get(u, ()):
                cand = (max(b, w), t + w)
                if v not in best or cand < best[v]:
                    best[v] = cand
                    heapq.heappush(heap, (cand[0], cand[1], v))
        return best[dst]

    assert naive_single_label(arcs, "O", "D") == (10, 16)  # wrong total
    b_star, total, path = two_pass_fallback(arcs, "O", "D")
    assert (b_star, total, path) == (10, 15, ["O", "X", "D"])


def test_exactly_on_threshold_is_accepted():
    arcs = {"O": [("D", to_um(150.0))]}
    assert shortest_within_limit(arcs, "O", "D", to_um(150.0)) == (to_um(150.0), ["O", "D"])
    assert shortest_within_limit(arcs, "O", "D", to_um(149.999999)) is None


def test_equal_bottleneck_prefers_shorter_total():
    arcs = {"O": [("a", 100), ("b", 100)], "a": [("D", 100)], "b": [("c", 50)], "c": [("D", 40)]}
    b_star, total, path = two_pass_fallback(arcs, "O", "D")
    assert b_star == 100
    assert total == 190 and path == ["O", "b", "c", "D"]


def test_deterministic_tie_break_fewer_legs_then_smaller_id():
    arcs = {"O": [("D", 200), ("s2", 100), ("s1", 100)], "s1": [("D", 100)], "s2": [("D", 100)]}
    assert shortest_within_limit(arcs, "O", "D", None) == (200, ["O", "D"])
    assert shortest_within_limit(arcs, "O", "D", 150) == (200, ["O", "s1", "D"])


@pytest.mark.parametrize("seed", range(80))
def test_monotonicity_in_limit(seed):
    rng = random.Random(1000 + seed)
    arcs = random_arcs(rng, 6, 0.4, 300)
    prev_feasible = False
    prev_total = None
    for L in range(0, 320, 20):
        r = shortest_within_limit(arcs, "O", "D", L)
        # tightening never helps = loosening never hurts
        if prev_feasible:
            assert r is not None
        if r is not None:
            if prev_total is not None:
                assert r[0] <= prev_total
            prev_total = r[0]
            prev_feasible = True


@pytest.mark.parametrize("seed", range(80))
def test_adding_a_seat_never_worsens_bottleneck(seed):
    rng = random.Random(5000 + seed)
    arcs = random_arcs(rng, 6, 0.4, 300)
    full = minimax_gap(arcs, "O", "D")
    removed = "s3"
    reduced = {u: [(v, w) for v, w in lst if v != removed] for u, lst in arcs.items() if u != removed}
    less = minimax_gap(reduced, "O", "D")
    if less is not None:
        assert full is not None and full <= less


@pytest.mark.parametrize("seed", range(200))
def test_sorted_extra_skip_variant_matches_oracle(seed):
    """The planner's fast path (sorted arcs, start arcs in `extra`, skipped
    seats) must give exactly the same answers as the plain version."""
    rng = random.Random(9000 + seed)
    arcs = random_arcs(rng, rng.randint(1, 7), rng.choice([0.3, 0.6, 0.9]), rng.choice([20, 400]))
    skip = {s for s in arcs if s.startswith("s") and rng.random() < 0.25}
    limit = rng.randint(0, 400)
    reduced = {u: [(v, w) for v, w in lst if v not in skip] for u, lst in arcs.items() if u not in skip}
    want = oracle(reduced, limit)
    base = {u: sorted([(v, w) for v, w in lst if v != "D"], key=lambda x: (x[1], x[0])) for u, lst in arcs.items() if u != "O"}
    extra = {"O": list(arcs["O"])}
    for u, lst in arcs.items():
        if u != "O":
            extra.setdefault(u, []).extend((v, w) for v, w in lst if v == "D")
    kw = {"extra": extra, "skip": frozenset(skip), "sorted_arcs": True}
    got_a = shortest_within_limit(base, "O", "D", limit, **kw)
    got_b = two_pass_fallback(base, "O", "D", **kw)
    if want is None:
        assert got_a is None and got_b is None
        return
    best_feasible, b_star, best_at_b = want
    assert (got_a[0] if got_a else None) == best_feasible
    assert got_b[0] == b_star and got_b[1] == best_at_b
    if got_a:
        assert not set(got_a[1]) & skip
