"""Pedestrian graph used by the router.

The walking network is stored as *segments*. A segment is one piece of
sidewalk/footpath/street between two nodes, with:

* a polyline geometry in a projected coordinate system (meters),
* a length in meters (the length of that projected polyline),
* two direction flags: may you walk a -> b, and may you walk b -> a?

Two-way paths are one segment with both flags set. A one-way pedestrian
path has only one flag set. Two different segments may join the same pair
of nodes (parallel edges); each keeps its own id and geometry, so a route
can always be redrawn along the exact piece of path that was used.

We never compute meters from latitude/longitude degrees. All lengths come
from projected coordinates (UTM zone 18N for New York, or a local
azimuthal-equidistant projection for the synthetic demo).
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from typing import Callable, Iterable

Coord = tuple[float, float]


def polyline_length(xy: list[Coord]) -> float:
    return sum(math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1))


@dataclass
class Segment:
    id: str
    a: str
    b: str
    xy: list[Coord]
    length_m: float
    forward: bool = True  # walking a -> b allowed
    backward: bool = True  # walking b -> a allowed
    kind: str = "path"  # "path" (real walkway) or "connector" (seat access link)
    tags: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Step:
    """One directed traversal of a segment: from node -> to node."""

    seg_id: str
    frm: str
    to: str
    length_m: float


class PedGraph:
    """Directed pedestrian graph with explicit segment identity."""

    def __init__(self, crs: str):
        self.crs = crs
        self.nodes: dict[str, Coord] = {}
        self.segments: dict[str, Segment] = {}
        self._out: dict[str, list[Step]] = {}
        self._in: dict[str, list[Step]] = {}

    # ----- construction -------------------------------------------------
    def add_node(self, node_id: str, xy: Coord) -> None:
        if node_id in self.nodes:
            return
        self.nodes[node_id] = (float(xy[0]), float(xy[1]))
        self._out.setdefault(node_id, [])
        self._in.setdefault(node_id, [])

    def add_segment(self, seg: Segment) -> None:
        if seg.id in self.segments:
            raise ValueError(f"duplicate segment id {seg.id}")
        if seg.a not in self.nodes or seg.b not in self.nodes:
            raise ValueError(f"segment {seg.id} references unknown node")
        if seg.length_m < 0 or math.isnan(seg.length_m):
            raise ValueError(f"segment {seg.id} has invalid length")
        self.segments[seg.id] = seg
        if seg.forward:
            st = Step(seg.id, seg.a, seg.b, seg.length_m)
            self._out[seg.a].append(st)
            self._in[seg.b].append(st)
        if seg.backward:
            st = Step(seg.id, seg.b, seg.a, seg.length_m)
            self._out[seg.b].append(st)
            self._in[seg.a].append(st)

    def remove_segment(self, seg_id: str) -> Segment:
        seg = self.segments.pop(seg_id)
        for n in (seg.a, seg.b):
            self._out[n] = [s for s in self._out[n] if s.seg_id != seg_id]
            self._in[n] = [s for s in self._in[n] if s.seg_id != seg_id]
        return seg

    def out_steps(self, node: str) -> list[Step]:
        return self._out.get(node, [])

    def in_steps(self, node: str) -> list[Step]:
        return self._in.get(node, [])

    def path_segments(self) -> Iterable[Segment]:
        return (s for s in self.segments.values() if s.kind == "path")

    # ----- geometry helpers ---------------------------------------------
    def step_xy(self, step: Step) -> list[Coord]:
        seg = self.segments[step.seg_id]
        return list(seg.xy) if step.frm == seg.a else list(reversed(seg.xy))

    # ----- shortest paths -------------------------------------------------
    def dijkstra(
        self,
        sources: dict[str, float],
        *,
        reverse: bool = False,
        stop_at: set[str] | None = None,
        cutoff: float | None = None,
    ) -> tuple[dict[str, float], dict[str, Step | None]]:
        """Multi-source Dijkstra with starting costs.

        ``sources`` maps node -> initial cost (used for points that sit part
        way along a segment). With ``reverse=True`` the search follows edges
        backwards, so ``dist[n]`` is the cost from ``n`` to the sources.
        ``pred[n]`` is the Step used to reach ``n`` (None for a source).

        Ties are broken deterministically by node id order in the heap.
        If ``stop_at`` is given, the search stops once all of those nodes
        are settled.
        """

        dist: dict[str, float] = {}
        pred: dict[str, Step | None] = {}
        heap: list[tuple[float, str]] = []
        best: dict[str, float] = {}
        for n, c in sorted(sources.items()):
            if n not in self.nodes:
                continue
            if c < best.get(n, math.inf):
                best[n] = c
                pred[n] = None
        for n, c in best.items():
            heapq.heappush(heap, (c, n))
        remaining = set(stop_at) if stop_at else None
        adj = self._in if reverse else self._out
        while heap:
            d, u = heapq.heappop(heap)
            if u in dist:
                continue
            if cutoff is not None and d > cutoff:
                break
            dist[u] = d
            if remaining is not None:
                remaining.discard(u)
                if not remaining:
                    break
            for st in adj.get(u, ()):
                v = st.frm if reverse else st.to
                if v in dist:
                    continue
                nd = d + st.length_m
                if nd < best.get(v, math.inf):
                    best[v] = nd
                    pred[v] = st
                    heapq.heappush(heap, (nd, v))
        return dist, {n: pred[n] for n in dist}


def make_transformer(crs: str) -> Callable[[float, float], tuple[float, float]]:
    """Return f(x, y) -> (lon, lat) for the graph's projected CRS."""
    from pyproj import Transformer

    t = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    return lambda x, y: t.transform(x, y)


def make_projector(crs: str) -> Callable[[float, float], tuple[float, float]]:
    """Return f(lon, lat) -> (x, y) in the graph's projected CRS."""
    from pyproj import Transformer

    t = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    return lambda lon, lat: t.transform(lon, lat)
