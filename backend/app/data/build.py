"""Turn a walking graph plus seat records into a routable dataset.

Used by both the synthetic demo loader and ``scripts/prepare_pilot.py`` so
that the demo exercises the same code as the real Flushing import.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field

from ..routing.attach import (
    Attachment,
    SegmentIndex,
    attachment_on_segment,
    choose_attachment,
    split_segments,
)
from ..routing.graph import PedGraph, Segment
from .seats import RULES, SeatRecord, dedupe, pre_attachment_exclusion, rules_hash


@dataclass
class BuiltSeats:
    seats: dict[str, SeatRecord]
    seat_node: dict[str, str]  # eligible seat id -> graph node id (the seat itself)
    merge_notes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Set when a dense area was thinned: {"min_spacing_m", "kept", "dropped"}
    thinned: dict | None = None


# Spacing (meters) tried, smallest first, until few enough benches remain.
THIN_SPACINGS_M = (10, 15, 20, 30, 45, 60, 90, 130, 200)


def _preference(s: SeatRecord) -> tuple:
    """Lower sorts first: backrest known-yes, then real benches over bus-stop
    seating, then NYC DOT's maintained records, then id (so the result is stable)."""
    kind = {"bench": 0, "shelter_bench": 1, "bus_stop_bench": 2}.get(s.type, 3)
    official = 0 if any(r.get("source") == "nyc_dot_seating" for r in s.source_refs) else 1
    return (0 if s.backrest is True else 1, kind, official, s.id)


def thin_seats(seats: list[SeatRecord], max_seats: int) -> tuple[list[SeatRecord], list[SeatRecord], float | None]:
    """Keep at most ``max_seats`` benches that are not close together.

    Benches are taken best-first and one is skipped when a bench already kept
    lies within the spacing. The spacing grows until few enough remain, so a
    dense area keeps its benches spread evenly instead of failing. Returns
    (kept, dropped, spacing used); spacing is None when nothing was dropped.
    """
    if len(seats) <= max_seats:
        return seats, [], None
    ranked = sorted(seats, key=_preference)
    for spacing in THIN_SPACINGS_M:
        grid: dict[tuple[int, int], list[SeatRecord]] = {}
        kept: list[SeatRecord] = []
        for s in ranked:
            cx, cy = int(s.x // spacing), int(s.y // spacing)
            near = (
                o
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                for o in grid.get((cx + dx, cy + dy), ())
            )
            if any((o.x - s.x) ** 2 + (o.y - s.y) ** 2 < spacing**2 for o in near):
                continue
            kept.append(s)
            grid.setdefault((cx, cy), []).append(s)
        if len(kept) <= max_seats:
            break
    else:
        kept = ranked[:max_seats]  # extremely dense: best-first, still bounded
        spacing = THIN_SPACINGS_M[-1]
    keep_ids = {s.id for s in kept}
    return [s for s in seats if s.id in keep_ids], [s for s in seats if s.id not in keep_ids], float(spacing)


def attach_seats(
    graph: PedGraph,
    seats: list[SeatRecord],
    *,
    rules: dict = RULES,
    curated_attachments: dict[str, str] | None = None,
    max_seats: int | None = None,
) -> BuiltSeats:
    """Attach eligible seats to the graph (mutates ``graph``).

    Each eligible seat becomes a leaf node at its recorded location, linked
    by a connector to the point where it projects onto its walkway. The
    connector length counts toward every leg that starts or ends there.

    With ``max_seats``, a dense area is thinned first (see ``thin_seats``) so
    the distance matrix stays small; skipped benches stay on the map, marked
    as not counted.
    """
    curated_attachments = curated_attachments or {}
    index = SegmentIndex(graph)
    candidates: list[SeatRecord] = []
    excluded: list[SeatRecord] = []
    atts: dict[str, Attachment] = {}
    for s in seats:
        reason = pre_attachment_exclusion(s, rules)
        if reason:
            s.routing_eligible = False
            s.exclusion_reason = reason
            excluded.append(s)
            continue
        if s.id in curated_attachments and curated_attachments[s.id] in graph.segments:
            att = attachment_on_segment(graph, curated_attachments[s.id], (s.x, s.y))
        else:
            att = choose_attachment(
                graph,
                index,
                (s.x, s.y),
                max_dist_m=rules["seat_attach_max_m"],
                ambiguity_margin_m=rules["ambiguity_margin_m"],
                min_separation_m=rules["ambiguity_min_separation_m"],
            )
        if att is None:
            s.routing_eligible = False
            s.exclusion_reason = f"No mapped walkway within {rules['seat_attach_max_m']:.0f} m"
            excluded.append(s)
            continue
        s.attachment_metadata = {
            "segment": att.seg_id,
            "connector_m": round(att.connector_m, 2),
            "method": "curated" if att.note == "curated attachment" else "nearest walkway",
            "note": att.note or None,
        }
        if att.ambiguous:
            s.routing_eligible = False
            s.exclusion_reason = "Ambiguous walkway attachment (" + att.note + ")"
            excluded.append(s)
            continue
        atts[s.id] = att
        candidates.append(s)

    kept, notes = dedupe(candidates, atts, rules)
    thinned = None
    dropped: list[SeatRecord] = []
    if max_seats is not None:
        kept, dropped, spacing = thin_seats(kept, max_seats)
        if dropped:
            for s in dropped:
                s.routing_eligible = False
                s.exclusion_reason = f"Skipped in a dense area: another bench within {spacing:.0f} m is used instead"
                excluded.append(s)
            thinned = {"min_spacing_m": spacing, "kept": len(kept), "dropped": len(dropped)}
    kept_ids = {s.id for s in kept}
    thinned_ids = {s.id for s in dropped} if thinned else set()
    merged_away = [s for s in candidates if s.id not in kept_ids and s.id not in thinned_ids]

    split_nodes = split_segments(graph, {sid: atts[sid] for sid in sorted(kept_ids)})
    seat_node: dict[str, str] = {}
    for s in kept:
        node = f"seat:{s.id}"
        graph.add_node(node, (s.x, s.y))
        graph.add_segment(
            Segment(
                id=f"conn:{s.id}",
                a=split_nodes[s.id],
                b=node,
                xy=[graph.nodes[split_nodes[s.id]], (s.x, s.y)],
                length_m=atts[s.id].connector_m,
                forward=True,
                backward=True,
                kind="connector",
            )
        )
        s.routing_eligible = True
        s.exclusion_reason = None
        seat_node[s.id] = node

    out: dict[str, SeatRecord] = {}
    for s in kept + excluded:
        out[s.id] = s
    warnings = []
    if merged_away:
        warnings.append(f"{len(merged_away)} duplicate seat record(s) merged into nearby records from another source")
    if thinned:
        warnings.append(
            f"Dense area: {thinned['dropped']} of {thinned['kept'] + thinned['dropped']} usable benches were skipped "
            f"so the rest are at least {thinned['min_spacing_m']:.0f} m apart; routes only use the benches kept"
        )
    return BuiltSeats(out, seat_node, notes, warnings, thinned)


def seat_distance_matrix(graph: PedGraph, seat_node: dict[str, str]) -> dict[str, dict[str, float]]:
    """Walking distance between every ordered pair of eligible seats.

    One full single-source search per seat; independent of the slider, so
    it is computed once and cached. Unreachable pairs are omitted.
    """
    nodes = {n: sid for sid, n in seat_node.items()}
    matrix: dict[str, dict[str, float]] = {}
    for sid in sorted(seat_node):
        dist, _ = graph.dijkstra({seat_node[sid]: 0.0})
        row = {}
        for n, d in dist.items():
            other = nodes.get(n)
            if other is not None and other != sid:
                row[other] = d
        matrix[sid] = row
    return matrix


def graph_fingerprint(graph: PedGraph) -> str:
    h = hashlib.sha256()
    h.update(graph.crs.encode())
    for nid in sorted(graph.nodes):
        x, y = graph.nodes[nid]
        h.update(f"n|{nid}|{x:.3f}|{y:.3f}\n".encode())
    for sid in sorted(graph.segments):
        s = graph.segments[sid]
        h.update(f"s|{sid}|{s.a}|{s.b}|{s.length_m:.4f}|{int(s.forward)}{int(s.backward)}|{s.kind}\n".encode())
    return h.hexdigest()


def graph_to_json(graph: PedGraph) -> dict:
    return {
        "crs": graph.crs,
        "nodes": {k: [round(v[0], 3), round(v[1], 3)] for k, v in graph.nodes.items()},
        "segments": [
            {
                "id": s.id,
                "a": s.a,
                "b": s.b,
                "xy": [[round(x, 3), round(y, 3)] for x, y in s.xy],
                "length_m": s.length_m,
                "forward": s.forward,
                "backward": s.backward,
                "kind": s.kind,
                "tags": s.tags,
            }
            for s in graph.segments.values()
        ],
    }


def graph_from_json(d: dict) -> PedGraph:
    g = PedGraph(d["crs"])
    for k, (x, y) in d["nodes"].items():
        g.add_node(k, (x, y))
    for s in d["segments"]:
        g.add_segment(
            Segment(
                id=s["id"],
                a=s["a"],
                b=s["b"],
                xy=[tuple(p) for p in s["xy"]],
                length_m=float(s["length_m"]),
                forward=bool(s["forward"]),
                backward=bool(s["backward"]),
                kind=s.get("kind", "path"),
                tags=s.get("tags", {}),
            )
        )
    return g


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def rules_summary() -> dict:
    return {"rules": RULES, "rules_hash": rules_hash()}


def dumps_compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)
