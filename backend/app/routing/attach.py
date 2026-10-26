"""Attaching points (seats, trip start/end) to the walking network.

A point is attached by projecting it onto the nearest walkway segment. The
straight line from the point to that projection is the *connector*; its
length is counted in every route that uses the point.

Seats are attached permanently: the walkway segment is split at the
projection and the seat becomes a leaf node at its real location, joined by
a short connector. Trip endpoints are attached *virtually* per request (no
graph mutation), so concurrent requests never interfere.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely import STRtree
from shapely.geometry import LineString, Point

from .graph import Coord, PedGraph, Segment, polyline_length

NODE_EPS_M = 0.01  # a projection this close to a segment end reuses that end node


@dataclass
class Candidate:
    seg_id: str
    distance_m: float
    offset_m: float
    snap_xy: Coord
    side: int  # +1 left of a->b, -1 right, 0 on the line


@dataclass
class Attachment:
    seg_id: str
    offset_m: float
    snap_xy: Coord
    point_xy: Coord
    connector_m: float
    side: int
    ambiguous: bool = False
    note: str = ""
    runner_up: dict | None = field(default=None)


def project_on_polyline(xy: list[Coord], p: Coord) -> tuple[float, Coord, float, int]:
    """Closest point on a polyline to p.

    Returns (offset along the line in meters, snapped point, distance, side).
    """
    best = (math.inf, 0.0, xy[0], 0)
    run = 0.0
    for i in range(len(xy) - 1):
        (x1, y1), (x2, y2) = xy[i], xy[i + 1]
        dx, dy = x2 - x1, y2 - y1
        seg_len = math.hypot(dx, dy)
        if seg_len == 0:
            continue
        t = ((p[0] - x1) * dx + (p[1] - y1) * dy) / (seg_len * seg_len)
        t = min(1.0, max(0.0, t))
        sx, sy = x1 + t * dx, y1 + t * dy
        d = math.hypot(p[0] - sx, p[1] - sy)
        if d < best[0] - 1e-12:
            cross = dx * (p[1] - y1) - dy * (p[0] - x1)
            side = 0 if abs(cross) < 1e-9 else (1 if cross > 0 else -1)
            best = (d, run + t * seg_len, (sx, sy), side)
        run += seg_len
    return best[1], best[2], best[0], best[3]


def sub_polyline(xy: list[Coord], t0: float, t1: float) -> list[Coord]:
    """Part of a polyline between offsets t0 and t1 (reversed if t1 < t0)."""
    if t1 < t0:
        return list(reversed(sub_polyline(xy, t1, t0)))
    out: list[Coord] = []
    run = 0.0
    for i in range(len(xy) - 1):
        a, b = xy[i], xy[i + 1]
        L = math.dist(a, b)
        s0, s1 = run, run + L
        if s1 >= t0 and s0 <= t1 and L > 0:
            u0 = max(0.0, (t0 - s0) / L)
            u1 = min(1.0, (t1 - s0) / L)
            pa = (a[0] + u0 * (b[0] - a[0]), a[1] + u0 * (b[1] - a[1]))
            pb = (a[0] + u1 * (b[0] - a[0]), a[1] + u1 * (b[1] - a[1]))
            if not out or math.dist(out[-1], pa) > 1e-9:
                out.append(pa)
            if math.dist(out[-1], pb) > 1e-9:
                out.append(pb)
        run = s1
    if not out:
        # zero-length request: return a single repeated point
        pt = point_at_offset(xy, t0)
        out = [pt, pt]
    elif len(out) == 1:
        out.append(out[0])
    return out


def point_at_offset(xy: list[Coord], t: float) -> Coord:
    run = 0.0
    for i in range(len(xy) - 1):
        a, b = xy[i], xy[i + 1]
        L = math.dist(a, b)
        if run + L >= t and L > 0:
            u = (t - run) / L
            return (a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]))
        run += L
    return xy[-1]


class SegmentIndex:
    """Spatial index over walkway (non-connector) segments."""

    def __init__(self, graph: PedGraph):
        self.graph = graph
        self.ids = [s.id for s in graph.path_segments()]
        self.tree = STRtree([LineString(graph.segments[i].xy) for i in self.ids]) if self.ids else None

    def candidates(self, p: Coord, max_dist_m: float) -> list[Candidate]:
        if self.tree is None:
            return []
        hits = self.tree.query(Point(p).buffer(max_dist_m))
        out = []
        for h in hits:
            seg = self.graph.segments[self.ids[int(h)]]
            off, snap, d, side = project_on_polyline(seg.xy, p)
            if d <= max_dist_m:
                out.append(Candidate(seg.id, d, off, snap, side))
        out.sort(key=lambda c: (round(c.distance_m, 6), c.seg_id))
        return out


def network_distance_between(graph: PedGraph, a: Candidate, b: Candidate, cutoff: float) -> float:
    """Walking distance between two projected points (both directions allowed
    by segment flags), capped at ``cutoff`` (returns inf beyond it)."""
    if a.seg_id == b.seg_id:
        return abs(a.offset_m - b.offset_m)
    sa, sb = graph.segments[a.seg_id], graph.segments[b.seg_id]
    sources = {sa.a: a.offset_m, sa.b: sa.length_m - a.offset_m}
    dist, _ = graph.dijkstra(sources, cutoff=cutoff)
    best = math.inf
    if sb.a in dist:
        best = min(best, dist[sb.a] + b.offset_m)
    if sb.b in dist:
        best = min(best, dist[sb.b] + sb.length_m - b.offset_m)
    return best


def choose_attachment(
    graph: PedGraph,
    index: SegmentIndex,
    p: Coord,
    *,
    max_dist_m: float,
    ambiguity_margin_m: float = 2.0,
    min_separation_m: float = 8.0,
    check_ambiguity: bool = True,
) -> Attachment | None:
    """Pick the walkway segment a point attaches to.

    Returns None if no walkway is within ``max_dist_m``. The attachment is
    flagged ``ambiguous`` when another walkway is almost as close, lies on
    a clearly different spot, and the two spots are far apart on foot
    (typical case: sidewalks on opposite sides of a road). Ambiguous seats
    are excluded from routing unless a curated attachment is supplied.
    """
    cands = index.candidates(p, max_dist_m)
    if not cands:
        return None
    best = cands[0]
    att = Attachment(best.seg_id, best.offset_m, best.snap_xy, p, best.distance_m, best.side)
    if not check_ambiguity:
        return att
    for c in cands[1:]:
        if c.distance_m - best.distance_m > ambiguity_margin_m:
            break
        sep = math.dist(c.snap_xy, best.snap_xy)
        if sep <= min_separation_m:
            continue
        cutoff = max(40.0, 2.5 * sep)
        walk = network_distance_between(graph, best, c, cutoff)
        if walk > cutoff:
            att.ambiguous = True
            att.note = (
                f"Another walkway is {c.distance_m:.1f} m away (vs {best.distance_m:.1f} m) "
                f"and is not a short walk from the nearest one."
            )
            att.runner_up = {"seg_id": c.seg_id, "distance_m": round(c.distance_m, 2)}
            break
    return att


def attachment_on_segment(graph: PedGraph, seg_id: str, p: Coord) -> Attachment:
    """Curated attachment: force a point onto a named segment."""
    seg = graph.segments[seg_id]
    off, snap, d, side = project_on_polyline(seg.xy, p)
    return Attachment(seg_id, off, snap, p, d, side, note="curated attachment")


def split_segments(graph: PedGraph, atts: dict[str, Attachment]) -> dict[str, str]:
    """Split walkway segments at attachment points.

    Returns point_id -> node id at the attachment location. Several points on
    one segment are handled in one pass; equal offsets share a node; a
    projection at a segment end reuses the end node. Direction flags, tags
    and geometry are preserved on every piece.
    """
    by_seg: dict[str, list[tuple[float, str]]] = {}
    for pid, att in atts.items():
        by_seg.setdefault(att.seg_id, []).append((att.offset_m, pid))
    result: dict[str, str] = {}
    for seg_id in sorted(by_seg):
        seg = graph.segments[seg_id]
        items = sorted(by_seg[seg_id])
        cut_offsets: list[float] = []
        cut_nodes: list[str] = []
        for off, pid in items:
            if off <= NODE_EPS_M:
                result[pid] = seg.a
                continue
            if off >= seg.length_m - NODE_EPS_M:
                result[pid] = seg.b
                continue
            if cut_offsets and off - cut_offsets[-1] <= NODE_EPS_M:
                result[pid] = cut_nodes[-1]
                continue
            node_id = f"{seg.id}@{len(cut_offsets)}"
            graph.add_node(node_id, point_at_offset(seg.xy, off))
            cut_offsets.append(off)
            cut_nodes.append(node_id)
            result[pid] = node_id
        if not cut_offsets:
            continue
        graph.remove_segment(seg.id)
        bounds = [0.0] + cut_offsets + [seg.length_m]
        names = [seg.a] + cut_nodes + [seg.b]
        for i in range(len(bounds) - 1):
            xy = sub_polyline(seg.xy, bounds[i], bounds[i + 1])
            graph.add_segment(
                Segment(
                    id=f"{seg.id}~{i}",
                    a=names[i],
                    b=names[i + 1],
                    xy=xy,
                    length_m=polyline_length(xy),
                    forward=seg.forward,
                    backward=seg.backward,
                    kind=seg.kind,
                    tags={**seg.tags, "split_from": seg.tags.get("split_from", seg.id)},
                )
            )
    return result
