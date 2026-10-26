"""Route search on the terminal graph H.

H has one node per *terminal*: the trip start, the trip end, and every
eligible seat. An arc u -> v means "walk the shortest path from u to v
without stopping"; its weight is that walking distance.

Weights here are integers in micrometers (1 m = 1_000_000). Integer
arithmetic makes "exactly at the limit" and ties exact, so results never
depend on floating-point rounding. Callers convert meters with ``to_um``.

Three searches:

* ``shortest_within_limit`` - shortest total distance using only arcs
  whose weight is <= limit (the user's maximum distance between rests).
* ``minimax_gap`` - the smallest possible "longest leg" over all routes
  (bottleneck shortest path).
* ``two_pass_fallback`` - minimax first, then the shortest route among
  routes whose every leg is <= that bottleneck value.

Deterministic tie-breaking for equal totals: fewer legs first, then the
predecessor terminal with the smallest id.

Speed-up for large seat sets (optional, used by the planner): ``arcs`` lists
may be pre-sorted by weight (``sorted_arcs=True``) so a scan can stop at
the first arc that is too long. ``extra`` holds a few per-request arcs
(start/destination) that are always scanned, and ``skip`` holds terminals
excluded for this request. Results are identical either way; the unit tests
check both paths against a brute-force oracle.
"""

from __future__ import annotations

import heapq
from typing import Mapping, Sequence

UM_PER_M = 1_000_000

Arcs = Mapping[str, Sequence[tuple[str, int]]]
_EMPTY: tuple = ()


def to_um(meters: float) -> int:
    return int(round(meters * UM_PER_M))


def to_m(um: int) -> float:
    return um / UM_PER_M


def shortest_within_limit(
    arcs: Arcs,
    src: str,
    dst: str,
    limit_um: int | None,
    *,
    extra: Arcs | None = None,
    skip: set[str] | frozenset = frozenset(),
    sorted_arcs: bool = False,
) -> tuple[int, list[str]] | None:
    """Lexicographic Dijkstra on (total distance, number of legs).

    Arcs heavier than ``limit_um`` are ignored (``None`` = no limit).
    Returns (total_um, [src, ..., dst]) or None if dst is unreachable.
    """
    if src == dst:
        return 0, [src]
    extra = extra or {}
    label: dict[str, tuple[int, int]] = {src: (0, 0)}
    pred: dict[str, str | None] = {src: None}
    done: set[str] = set()
    heap: list[tuple[int, int, str]] = [(0, 0, src)]

    def relax(u: str, d: int, h: int, v: str, w: int) -> None:
        cand = (d + w, h + 1)
        old = label.get(v)
        if old is None or cand < old or (cand == old and u < (pred[v] or "")):
            label[v] = cand
            pred[v] = u
            heapq.heappush(heap, (cand[0], cand[1], v))

    while heap:
        d, h, u = heapq.heappop(heap)
        if u in done:
            continue
        done.add(u)
        if u == dst:
            break
        for v, w in extra.get(u, _EMPTY):
            if (limit_um is None or w <= limit_um) and v not in done and v not in skip:
                relax(u, d, h, v, w)
        for v, w in arcs.get(u, _EMPTY):
            if limit_um is not None and w > limit_um:
                if sorted_arcs:
                    break
                continue
            if v in done or v in skip:
                continue
            relax(u, d, h, v, w)
    if dst not in done:
        return None
    path = [dst]
    while pred[path[-1]] is not None:
        path.append(pred[path[-1]])  # type: ignore[arg-type]
    path.reverse()
    return label[dst][0], path


def minimax_gap(
    arcs: Arcs,
    src: str,
    dst: str,
    *,
    extra: Arcs | None = None,
    skip: set[str] | frozenset = frozenset(),
    sorted_arcs: bool = False,
) -> int | None:
    """Smallest achievable maximum arc weight over all src -> dst paths.

    Minimax Dijkstra: b(src) = 0, relaxing u -> v gives max(b(u), w).
    Arcs at least as long as the best value already found for dst cannot
    improve the answer, so sorted scans stop there.
    """
    if src == dst:
        return 0
    extra = extra or {}
    best: dict[str, int] = {src: 0}
    done: set[str] = set()
    heap: list[tuple[int, str]] = [(0, src)]
    while heap:
        b, u = heapq.heappop(heap)
        if u in done:
            continue
        done.add(u)
        if u == dst:
            return b
        for v, w in extra.get(u, _EMPTY):
            if v in done or v in skip:
                continue
            cand = b if b > w else w
            if cand < best.get(v, cand + 1):
                best[v] = cand
                heapq.heappush(heap, (cand, v))
        bound = best.get(dst)
        for v, w in arcs.get(u, _EMPTY):
            if bound is not None and w >= bound:
                if sorted_arcs:
                    break
                continue
            if v in done or v in skip:
                continue
            cand = b if b > w else w
            if cand < best.get(v, cand + 1):
                best[v] = cand
                heapq.heappush(heap, (cand, v))
                if v == dst:
                    bound = cand
    return None


def two_pass_fallback(
    arcs: Arcs,
    src: str,
    dst: str,
    *,
    extra: Arcs | None = None,
    skip: set[str] | frozenset = frozenset(),
    sorted_arcs: bool = False,
) -> tuple[int, int, list[str]] | None:
    """Return (bottleneck_um, total_um, path) or None if disconnected.

    Pass 1 finds B*, the smallest possible longest leg. Pass 2 keeps only
    arcs <= B* and finds the shortest total route among them. Keeping a
    single (bottleneck, total) label per node would be wrong: a later long
    leg can erase the bottleneck advantage of a prefix that was kept.
    """
    kw = {"extra": extra, "skip": skip, "sorted_arcs": sorted_arcs}
    b_star = minimax_gap(arcs, src, dst, **kw)
    if b_star is None:
        return None
    res = shortest_within_limit(arcs, src, dst, b_star, **kw)
    assert res is not None, "a path with max leg B* must exist"
    return b_star, res[0], res[1]
