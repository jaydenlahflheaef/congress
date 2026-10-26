"""Plan a trip: attach endpoints, build the terminal graph, search, redraw.

Outline (see docs/algorithm.md for the plain-language version):

1. Check both endpoints are inside the pilot service area.
2. Attach each endpoint to the nearest walkway (virtual point, no graph
   mutation). Reject snaps farther than MAX_ENDPOINT_SNAP_M.
3. One forward search from the start and one reverse search from the
   destination give start->seat, seat->destination and start->destination
   distances. Seat->seat distances were precomputed when the data loaded.
4. Search the terminal graph H (start, destination, eligible seats):
   A. shortest route whose every leg is <= the limit, else
   B. two-pass minimax fallback (smallest possible longest leg, then the
      shortest route that achieves it).
5. Redraw every leg along real walkway geometry.
"""

from __future__ import annotations

import math
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass

from shapely.geometry import Point

from ..data.dataset import Dataset
from .attach import Attachment, SegmentIndex, choose_attachment, point_at_offset, sub_polyline
from .graph import Coord, Step, make_projector
from .terminal import shortest_within_limit, to_m, to_um, two_pass_fallback

MAX_ENDPOINT_SNAP_M = 60.0
SNAP_WARN_M = 25.0
SAME_POINT_M = 0.5
HYP_MAX_SNAP_M = 15.0  # a hypothetical bench must be placed on (or next to) a mapped walkway
ORIGIN = "@origin"
DEST = "@destination"

LIMITATION_NOTE = (
    "Seat records can be incomplete or outdated. A seat may be occupied or unavailable. "
    "Routes do not verify every curb, slope, crossing, or surface."
)


@dataclass
class VirtualPoint:
    """A trip endpoint attached part-way along a walkway segment."""

    att: Attachment
    request_xy: Coord

    def out_sources(self, g) -> dict[str, float]:
        seg = g.segments[self.att.seg_id]
        c, off, L = self.att.connector_m, self.att.offset_m, seg.length_m
        out: dict[str, float] = {}
        if off <= 0.01:
            out[seg.a] = c + off
        if off >= L - 0.01:
            out[seg.b] = min(out.get(seg.b, math.inf), c + (L - off))
        if seg.forward:
            out[seg.b] = min(out.get(seg.b, math.inf), c + (L - off))
        if seg.backward:
            out[seg.a] = min(out.get(seg.a, math.inf), c + off)
        return out

    def in_targets(self, g) -> dict[str, float]:
        seg = g.segments[self.att.seg_id]
        c, off, L = self.att.connector_m, self.att.offset_m, seg.length_m
        out: dict[str, float] = {}
        if off <= 0.01:
            out[seg.a] = c + off
        if off >= L - 0.01:
            out[seg.b] = min(out.get(seg.b, math.inf), c + (L - off))
        if seg.forward:
            out[seg.a] = min(out.get(seg.a, math.inf), off + c)
        if seg.backward:
            out[seg.b] = min(out.get(seg.b, math.inf), (L - off) + c)
        return out


def same_segment_cost(g, p: VirtualPoint, q: VirtualPoint) -> float:
    """Walk directly along one segment from p to q (if both sit on it)."""
    if p.att.seg_id != q.att.seg_id:
        return math.inf
    seg = g.segments[p.att.seg_id]
    d = q.att.offset_m - p.att.offset_m
    if (d >= 0 and seg.forward) or (d <= 0 and seg.backward) or abs(d) <= 0.01:
        return p.att.connector_m + abs(d) + q.att.connector_m
    return math.inf


class Planner:
    def __init__(self, ds: Dataset, cache_size: int = 64):
        self.ds = ds
        self.g = ds.graph
        self.index = SegmentIndex(ds.graph)
        self.project = make_projector(ds.graph.crs)
        self._cache: OrderedDict = OrderedDict()
        self._cache_size = cache_size
        self._lock = threading.Lock()
        self.node_seat = {n: sid for sid, n in ds.seat_node.items()}
        # Seat-to-seat arcs as integers (micrometers), sorted by length so a
        # search can stop scanning at the first arc that is too long.
        self.seat_rows: dict[str, list[tuple[str, int]]] = {}
        for sid in sorted(ds.seat_node):
            row = ds.matrix.get(sid, {})
            lst = [(t, to_um(d)) for t, d in row.items() if t in ds.seat_node]
            lst.sort(key=lambda x: (x[1], x[0]))
            self.seat_rows[sid] = lst

    # ------------------------------------------------------------------
    def _lonlat(self, xy: Coord) -> list[float]:
        lon, lat = self.ds.to_lonlat(xy[0], xy[1])
        return [round(lon, 7), round(lat, 7)]

    def _endpoint_info(self, req_ll, vp: VirtualPoint) -> dict:
        lon, lat = self.ds.to_lonlat(*vp.att.snap_xy)
        return {
            "requested": {"lat": req_ll[1], "lon": req_ll[0]},
            "snapped": {"lat": round(lat, 7), "lon": round(lon, 7)},
            "snap_distance_m": round(vp.att.connector_m, 1),
        }

    def _endpoint_searches(self, o: VirtualPoint, d: VirtualPoint):
        """Forward search from o and reverse search to d, cached per trip."""
        key = (
            self.ds.version,
            self.ds.rules_hash,
            round(o.request_xy[0], 2),
            round(o.request_xy[1], 2),
            round(d.request_xy[0], 2),
            round(d.request_xy[1], 2),
        )
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key], True
        fwd, _ = self.g.dijkstra(o.out_sources(self.g))
        rev, _ = self.g.dijkstra(d.in_targets(self.g), reverse=True)
        direct = min(
            [fwd[n] + c for n, c in d.in_targets(self.g).items() if n in fwd] + [same_segment_cost(self.g, o, d)],
            default=math.inf,
        )
        from_o = {sid: fwd[n] for sid, n in self.ds.seat_node.items() if n in fwd}
        to_d = {sid: rev[n] for sid, n in self.ds.seat_node.items() if n in rev}
        val = (from_o, to_d, direct)
        with self._lock:
            self._cache[key] = val
            if len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return val, False

    # ------------------------------------------------------------------
    def _leg_path(self, u: str, v: str, virtual: dict[str, VirtualPoint]) -> tuple[float, list[Coord], list[str]]:
        """Redraw one leg along real walkways. Returns (length, xy, segment ids).

        ``virtual`` maps terminal ids that are points along a segment (start,
        destination, hypothetical benches) to their attachment; any other
        terminal id is a seat node.
        """
        g = self.g
        src = virtual[u].out_sources(g) if u in virtual else {self.ds.seat_node[u]: 0.0}
        tgt = virtual[v].in_targets(g) if v in virtual else {self.ds.seat_node[v]: 0.0}
        dist, pred = g.dijkstra(src, stop_at=set(tgt))
        best_n, best = None, math.inf
        for n in sorted(tgt):
            if n in dist and dist[n] + tgt[n] < best:
                best_n, best = n, dist[n] + tgt[n]
        if u in virtual and v in virtual:
            pu, pv = virtual[u], virtual[v]
            direct = same_segment_cost(g, pu, pv)
            if direct <= best:
                seg = g.segments[pu.att.seg_id]
                xy = [pu.request_xy] + sub_polyline(seg.xy, pu.att.offset_m, pv.att.offset_m) + [pv.request_xy]
                return direct, _dedupe(xy), [seg.id]
        if best_n is None:
            raise RuntimeError(f"leg {u}->{v} unreachable during reconstruction")
        steps: list[Step] = []
        n = best_n
        while pred[n] is not None:
            st = pred[n]
            steps.append(st)
            n = st.frm
        steps.reverse()
        start_node = n
        xy: list[Coord] = []
        if u in virtual:
            pu = virtual[u]
            seg = g.segments[pu.att.seg_id]
            xy.append(pu.request_xy)
            end_off = 0.0 if start_node == seg.a else seg.length_m
            xy.extend(sub_polyline(seg.xy, pu.att.offset_m, end_off))
        else:
            xy.append(g.nodes[start_node])
        for st in steps:
            xy.extend(g.step_xy(st))
        if v in virtual:
            pv = virtual[v]
            seg = g.segments[pv.att.seg_id]
            start_off = 0.0 if best_n == seg.a else seg.length_m
            xy.extend(sub_polyline(seg.xy, start_off, pv.att.offset_m))
            xy.append(pv.request_xy)
        return best, _dedupe(xy), [st.seg_id for st in steps]

    def _hypothetical_arcs(self, hyps: dict[str, VirtualPoint], o: VirtualPoint, d: VirtualPoint):
        """Arcs between hypothetical benches and every other terminal.

        A hypothetical bench sits on a walkway (connector 0), which is the
        same as splitting the walkway there. Two searches per bench (forward
        and reverse) give all its distances. Returns {(u, v): weight_um}.
        """
        g = self.g
        w: dict[tuple[str, str], int] = {}
        fwd, rev = {}, {}
        for hid, h in hyps.items():
            fwd[hid], _ = g.dijkstra(h.out_sources(g))
            rev[hid], _ = g.dijkstra(h.in_targets(g), reverse=True)

        def reach(dist_from: dict, targets: dict, same_seg: float) -> float:
            return min([dist_from[n] + c for n, c in targets.items() if n in dist_from] + [same_seg], default=math.inf)

        for hid, h in hyps.items():
            # start -> bench: leave the start, then the bench's reverse search gives node -> bench
            o_h = reach(rev[hid], o.out_sources(g), same_segment_cost(g, o, h))
            h_d = reach(fwd[hid], d.in_targets(g), same_segment_cost(g, h, d))
            if not math.isinf(o_h):
                w[(ORIGIN, hid)] = to_um(o_h)
            if not math.isinf(h_d):
                w[(hid, DEST)] = to_um(h_d)
            for sid, node in self.ds.seat_node.items():
                if node in fwd[hid]:
                    w[(hid, sid)] = to_um(fwd[hid][node])
                if node in rev[hid]:
                    w[(sid, hid)] = to_um(rev[hid][node])
            for hj, pj in hyps.items():
                if hj != hid:
                    x = reach(fwd[hid], pj.in_targets(g), same_segment_cost(g, h, pj))
                    if not math.isinf(x):
                        w[(hid, hj)] = to_um(x)
        return w

    # ------------------------------------------------------------------
    def plan(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        max_gap_m: float,
        excluded_seat_ids: list[str],
        request_id: str | None = None,
        hypothetical: list[tuple[float, float]] | None = None,
    ) -> dict:
        t0 = time.perf_counter()
        ds = self.ds
        base = {
            "request_id": request_id or uuid.uuid4().hex,
            "dataset_version": ds.version,
            "data_mode": ds.mode,
            "coverage": {"area_name": ds.area_name},
            "requested_max_gap_m": max_gap_m,
            "total_distance_m": None,
            "longest_gap_m": None,
            "minimum_required_gap_m": None,
            "rest_count": None,
            "extra_distance_m": None,
            "comparison_distance_m": None,
            "route_geojson": None,
            "comparison_geojson": None,
            "stops": [],
            "legs": [],
            "over_limit_legs": [],
            "warnings": [],
            "snapped_endpoints": None,
            "limitation_note": LIMITATION_NOTE,
            "hypothetical": None,
        }
        o_xy = self.project(origin[0], origin[1])
        d_xy = self.project(destination[0], destination[1])
        outside = [
            name
            for name, xy in (("start", o_xy), ("destination", d_xy))
            if not ds.service_polygon_xy.covers(Point(xy))
        ]
        if outside:
            return {
                **base,
                "status": "unsupported_area",
                "message": f"The {' and '.join(outside)} {'is' if len(outside) == 1 else 'are'} outside the {ds.area_name} coverage area shown on the map.",
            }
        vps = {}
        for name, xy in (("start", o_xy), ("destination", d_xy)):
            att = choose_attachment(self.g, self.index, xy, max_dist_m=MAX_ENDPOINT_SNAP_M, check_ambiguity=False)
            if att is None:
                return {
                    **base,
                    "status": "endpoint_unresolved",
                    "message": f"The {name} is more than {MAX_ENDPOINT_SNAP_M:.0f} m from any mapped walkway, so we could not attach it to the walking network. Try placing it on a street or path.",
                }
            vps[name] = VirtualPoint(att, xy)
        o, d = vps["start"], vps["destination"]
        snapped = {"origin": self._endpoint_info(origin, o), "destination": self._endpoint_info(destination, d)}
        warnings = []
        for label, vp in (("Start", o), ("Destination", d)):
            if vp.att.connector_m > SNAP_WARN_M:
                warnings.append(
                    f"{label} was {vp.att.connector_m:.0f} m from the nearest mapped walkway; that distance is included."
                )
        base["snapped_endpoints"] = snapped

        if math.dist(o_xy, d_xy) <= SAME_POINT_M:
            return {
                **base,
                "status": "ok",
                "message": "Start and destination are the same place.",
                "total_distance_m": 0.0,
                "longest_gap_m": 0.0,
                "rest_count": 0,
                "extra_distance_m": 0.0,
                "comparison_distance_m": 0.0,
                "route_geojson": {"type": "FeatureCollection", "features": []},
                "comparison_geojson": {"type": "FeatureCollection", "features": []},
                "warnings": warnings,
            }

        (from_o, to_d, direct), cached = self._endpoint_searches(o, d)
        if math.isinf(direct):
            return {
                **base,
                "status": "disconnected",
                "message": "The start and destination are on parts of the mapped walking network that do not connect. "
                "There may be a real connection that is missing from the map.",
                "warnings": warnings,
            }

        excluded = set(excluded_seat_ids)
        unknown_excl = sorted(excluded - set(ds.seats))
        skip = frozenset(excluded & set(ds.seat_node))
        direct_um = to_um(direct)
        o_arcs = {sid: to_um(dm) for sid, dm in from_o.items()}
        d_arcs = {sid: to_um(dm) for sid, dm in to_d.items()}
        extra: dict[str, list[tuple[str, int]]] = {
            ORIGIN: [(DEST, direct_um)] + sorted(o_arcs.items(), key=lambda x: (x[1], x[0]))
        }
        for sid, w in d_arcs.items():
            extra[sid] = [(DEST, w)]

        # Optional planning experiment: hypothetical benches (never stored).
        hyps: dict[str, VirtualPoint] = {}
        hyp_info = []
        for i, (lon, lat) in enumerate(hypothetical or [], start=1):
            hxy = self.project(lon, lat)
            if not ds.service_polygon_xy.covers(Point(hxy)):
                warnings.append(f"Hypothetical bench {i} ignored: outside the covered area.")
                continue
            att = choose_attachment(self.g, self.index, hxy, max_dist_m=HYP_MAX_SNAP_M, check_ambiguity=False)
            if att is None:
                warnings.append(f"Hypothetical bench {i} ignored: not within {HYP_MAX_SNAP_M:.0f} m of a mapped walkway.")
                continue
            on_walkway = Attachment(att.seg_id, att.offset_m, att.snap_xy, att.snap_xy, 0.0, att.side)
            hid = f"@hyp{i}"
            hyps[hid] = VirtualPoint(on_walkway, att.snap_xy)
            slon, slat = ds.to_lonlat(*att.snap_xy)
            hyp_info.append(
                {"id": hid, "label": f"Hypothetical bench {i}", "lat": round(slat, 7), "lon": round(slon, 7),
                 "moved_m": round(att.connector_m, 1)}
            )
        hyp_w = self._hypothetical_arcs(hyps, o, d) if hyps else {}
        for (u, v), wt in sorted(hyp_w.items()):
            extra.setdefault(u, []).append((v, wt))

        def weight(u: str, v: str) -> int:
            if (u, v) in hyp_w:
                return hyp_w[(u, v)]
            if u == ORIGIN:
                return direct_um if v == DEST else o_arcs[v]
            if v == DEST:
                return d_arcs[u]
            return to_um(ds.matrix[u][v])

        limit_um = to_um(max_gap_m)

        def solve(skip_set):
            kw = {"extra": extra, "skip": skip_set, "sorted_arcs": True}
            r = shortest_within_limit(self.seat_rows, ORIGIN, DEST, limit_um, **kw)
            if r is not None:
                return "ok", None, r[0], r[1]
            fb = two_pass_fallback(self.seat_rows, ORIGIN, DEST, **kw)
            assert fb is not None  # direct arc exists, so connected
            return "limit_unmet", fb[0], fb[1], fb[2]

        status, b_star, total_um, path = solve(skip)
        hypothetical_out = None
        if hyps:
            w_status, w_b, w_total, w_path = solve(skip | frozenset(hyps))
            w_legs = [weight(w_path[i], w_path[i + 1]) for i in range(len(w_path) - 1)]
            hypothetical_out = {
                "benches": hyp_info,
                "used": [h for h in path if h in hyps],
                "without": {
                    "status": w_status,
                    "total_distance_m": round(to_m(w_total), 2),
                    "longest_gap_m": round(to_m(max(w_legs, default=0)), 2),
                    "minimum_required_gap_m": round(to_m(w_b), 2) if w_b is not None else None,
                    "rest_count": len(w_path) - 2,
                },
                "note": "Hypothetical benches are a planning experiment. They are not real seats, are not saved, "
                "and results depend on map coverage. This does not establish installation permission or engineering feasibility.",
            }
        virtual = {ORIGIN: o, DEST: d, **hyps}

        # Redraw legs
        legs, features, stops = [], [], []
        seg_lookup = {ORIGIN: "Start", DEST: "Destination"}
        stop_no = {}
        for i, sid in enumerate(path[1:-1], start=1):
            stop_no[sid] = i
            seg_lookup[sid] = f"Seat {i}" if sid not in hyps else f"Hypothetical bench {sid[4:]}"
        for i in range(len(path) - 1):
            u, v = path[i], path[i + 1]
            length, xy, _segs = self._leg_path(u, v, virtual)
            w_uv = weight(u, v)
            planned = to_m(w_uv)
            if abs(length - planned) > 1e-3:
                warnings.append(f"Internal check: leg {i + 1} redraw differs from planned distance by {abs(length - planned):.3f} m")
            over = w_uv > limit_um
            leg = {
                "index": i + 1,
                "from_id": u,
                "to_id": v,
                "from_label": seg_lookup[u],
                "to_label": seg_lookup[v],
                "distance_m": round(planned, 2),
                "over_limit": over,
                "exceeds_by_m": round(planned - max_gap_m, 2) if over else 0.0,
            }
            legs.append(leg)
            features.append(
                {
                    "type": "Feature",
                    "properties": {k: leg[k] for k in ("index", "distance_m", "over_limit", "from_label", "to_label")},
                    "geometry": {"type": "LineString", "coordinates": [self._lonlat(p) for p in xy]},
                }
            )
        for sid in path[1:-1]:
            if sid in hyps:
                h = next(x for x in hyp_info if x["id"] == sid)
                stops.append(_hypothetical_stop(stop_no[sid], h))
                continue
            s = ds.seats[sid]
            stops.append({"number": stop_no[sid], **s.to_public()})

        cmp_len, cmp_xy, _ = self._leg_path(ORIGIN, DEST, virtual)
        comparison = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"distance_m": round(cmp_len, 2), "kind": "shortest_walk"},
                    "geometry": {"type": "LineString", "coordinates": [self._lonlat(p) for p in cmp_xy]},
                }
            ],
        }
        total_m = to_m(total_um)
        longest = max((leg["distance_m"] for leg in legs), default=0.0)
        if excluded:
            warnings.append(f"{len(excluded & set(ds.seats))} seat(s) excluded by you for this trip.")
        if unknown_excl:
            warnings.append(f"Ignored {len(unknown_excl)} excluded seat id(s) not in this dataset.")
        if status == "ok":
            msg = f"Every leg is {max_gap_m:.0f} m or less. Based on recorded seating and mapped paths."
        else:
            msg = (
                f"No route within {max_gap_m:.0f} m found in this mapped area. "
                f"The smallest achievable longest gap is {to_m(b_star):.0f} m."
            )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        return {
            **base,
            "status": status,
            "message": msg,
            "total_distance_m": round(total_m, 2),
            "longest_gap_m": round(longest, 2),
            "minimum_required_gap_m": round(to_m(b_star), 2) if b_star is not None else None,
            "rest_count": len(path) - 2,
            "extra_distance_m": round(total_m - direct, 2),
            "comparison_distance_m": round(direct, 2),
            "route_geojson": {"type": "FeatureCollection", "features": features},
            "comparison_geojson": comparison,
            "stops": stops,
            "legs": legs,
            "over_limit_legs": [leg["index"] for leg in legs if leg["over_limit"]],
            "warnings": warnings,
            "timing_ms": round(elapsed_ms, 1),
            "endpoint_cache_hit": cached,
            "seats_considered": len(ds.seat_node) - len(skip),
            "hypothetical": hypothetical_out,
        }


def _hypothetical_stop(number: int, h: dict) -> dict:
    return {
        "number": number,
        "id": h["id"],
        "hypothetical": True,
        "lon": h["lon"],
        "lat": h["lat"],
        "type": "hypothetical",
        "type_label": "Hypothetical bench (not a real seat)",
        "label": h["label"],
        "source_refs": [{"source": "hypothetical", "source_id": h["id"], "url": None}],
        "public_access": "unknown",
        "backrest": None,
        "armrests": None,
        "covered": None,
        "opening_hours": None,
        "availability_status": "hypothetical",
        "imported_at": None,
        "source_updated_at": None,
        "last_field_verified_at": None,
        "routing_eligible": True,
        "exclusion_reason": None,
        "attachment_metadata": {"connector_m": 0.0, "method": "placed on walkway"},
        "seat_count": 1,
    }


def _dedupe(xy: list[Coord]) -> list[Coord]:
    out: list[Coord] = []
    for p in xy:
        if not out or math.dist(out[-1], p) > 1e-6:
            out.append(p)
    if len(out) == 1:
        out.append(out[0])
    return out
