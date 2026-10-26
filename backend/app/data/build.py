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


def attach_seats(
    graph: PedGraph,
    seats: list[SeatRecord],
    *,
    rules: dict = RULES,
    curated_attachments: dict[str, str] | None = None,
) -> BuiltSeats:
    """Attach eligible seats to the graph (mutates ``graph``).

    Each eligible seat becomes a leaf node at its recorded location, linked
    by a connector to the point where it projects onto its walkway. The
    connector length counts toward every leg that starts or ends there.
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
    kept_ids = {s.id for s in kept}
    merged_away = [s for s in candidates if s.id not in kept_ids]

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
    return BuiltSeats(out, seat_node, notes, warnings)


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
