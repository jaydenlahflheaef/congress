"""Seat records and the rules that decide which seats the router may use.

Import time is not verification time: ``imported_at`` records when we copied
a record, ``last_field_verified_at`` is set only from an actual field check.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field

# Seat types we normalise every source into.
SEATED_TYPES = {"bench", "bus_stop_bench", "shelter_bench"}
SEAT_TYPE_LABELS = {
    "bench": "Bench",
    "bus_stop_bench": "Bench at bus stop",
    "shelter_bench": "Bench in shelter",
    "leaning_bar": "Leaning bar",
    "shelter_unknown_seating": "Shelter or stop, seating not recorded",
    "unknown": "Seat type not recorded",
}

# Bump RULES["version"] whenever eligibility logic changes; it is part of
# every cache key and of the dataset manifest.
RULES = {
    "version": "seat-rules-v1",
    "seat_attach_max_m": 20.0,
    "ambiguity_margin_m": 2.0,
    "ambiguity_min_separation_m": 8.0,
    "dedupe_max_m": 5.0,
    "leaning_bars_count_as_rest": False,
    "unknown_type_counts_as_rest": False,
    "shelter_without_recorded_seating_counts": False,
    "seats_with_opening_hours_count": False,
}


def rules_hash(rules: dict = RULES) -> str:
    return hashlib.sha256(json.dumps(rules, sort_keys=True).encode()).hexdigest()[:12]


@dataclass
class SeatRecord:
    id: str
    lon: float
    lat: float
    type: str
    source_refs: list[dict] = field(default_factory=list)
    label: str = ""
    public_access: str = "unknown"  # yes | no | unknown
    backrest: bool | None = None
    armrests: bool | None = None
    covered: bool | None = None
    opening_hours: str | None = None
    availability_status: str = "on_record"  # on_record | field_checked | unavailable
    imported_at: str | None = None
    source_updated_at: str | None = None
    last_field_verified_at: str | None = None
    routing_eligible: bool = False
    exclusion_reason: str | None = None
    attachment_metadata: dict | None = None
    seat_count: int = 1
    # projected coordinates (meters), filled in by the dataset builder
    x: float = 0.0
    y: float = 0.0

    def to_public(self) -> dict:
        d = asdict(self)
        d.pop("x")
        d.pop("y")
        d["type_label"] = SEAT_TYPE_LABELS.get(self.type, self.type)
        return d


def pre_attachment_exclusion(seat: SeatRecord, rules: dict = RULES) -> str | None:
    """Reasons a seat is ineligible regardless of where it is."""
    if seat.availability_status == "unavailable":
        return "Reported missing or unusable in a field check"
    if seat.type == "leaning_bar" and not rules["leaning_bars_count_as_rest"]:
        return "Leaning bar (standing rest only); not counted as a seat by default"
    if seat.type == "shelter_unknown_seating" and not rules["shelter_without_recorded_seating_counts"]:
        return "Shelter or bus stop without recorded seating"
    if seat.type == "unknown" and not rules["unknown_type_counts_as_rest"]:
        return "Seat type not recorded in the source (could be a leaning bar)"
    if seat.type not in SEATED_TYPES and seat.type not in {"leaning_bar", "shelter_unknown_seating", "unknown"}:
        return f"Unsupported seat type {seat.type!r}"
    if seat.public_access == "no":
        return "Not recorded as public seating"
    if seat.opening_hours and seat.opening_hours.strip() != "24/7" and not rules["seats_with_opening_hours_count"]:
        return f"Has opening hours ({seat.opening_hours}); may be closed"
    return None


def types_compatible(a: str, b: str) -> bool:
    if a in SEATED_TYPES and b in SEATED_TYPES:
        return True
    return a == b


def dedupe(seats: list[SeatRecord], atts: dict, rules: dict = RULES) -> tuple[list[SeatRecord], list[str]]:
    """Cautious duplicate merging.

    Two records merge only if ALL hold: within ``dedupe_max_m`` of each
    other, compatible types, attached to the same walkway segment, and on
    the same side of it. Seats that are close but attached to different
    walkways (for example across a road) are never merged.

    The kept record is the one listed first after sorting by (source
    priority, id); its location is used. Source references are combined.
    """
    priority = {"nyc_dot_seating": 0, "osm": 1, "synthetic": 2, "curated": 3}

    def key(s: SeatRecord):
        src = s.source_refs[0]["source"] if s.source_refs else "zzz"
        return (priority.get(src, 9), s.id)

    ordered = sorted(seats, key=key)
    kept: list[SeatRecord] = []
    notes: list[str] = []
    for s in ordered:
        att = atts.get(s.id)
        merged = False
        if att is not None:
            for k in kept:
                katt = atts.get(k.id)
                if katt is None or katt.seg_id != att.seg_id:
                    continue
                if not types_compatible(k.type, s.type):
                    continue
                if math.dist((k.x, k.y), (s.x, s.y)) > rules["dedupe_max_m"]:
                    continue
                if k.x == s.x and k.y == s.y:
                    pass  # identical point: same side by definition
                elif att.side != katt.side and 0 not in (att.side, katt.side):
                    continue
                k.source_refs.extend(s.source_refs)
                k.seat_count += s.seat_count
                for f in ("backrest", "armrests", "covered"):
                    if getattr(k, f) is None and getattr(s, f) is not None:
                        setattr(k, f, getattr(s, f))
                notes.append(f"merged {s.id} into {k.id}")
                merged = True
                break
        if not merged:
            kept.append(s)
    kept.sort(key=lambda s: s.id)
    return kept, notes
