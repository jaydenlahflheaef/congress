#!/usr/bin/env python3
"""Routing benchmark.

Measures (1) the synthetic demo and (2) a generated stress grid sized like
a neighborhood pilot (a street grid with many seats). The stress grid is
generated test data, NOT Flushing; it only tells us whether the algorithm
is fast enough at that size. Run the import first and pass --live to also
time the real pilot.

    python scripts/benchmark.py [--live] [--grid 40] [--seats 300]
"""

from __future__ import annotations

import argparse
import random
import statistics
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.data.dataset import build_synthetic, load_live, load_synthetic  # noqa: E402
from app.routing.planner import Planner  # noqa: E402


def stress_fixture(n: int, n_seats: int, spacing: float = 80.0, seed: int = 7) -> dict:
    rng = random.Random(seed)
    nodes = {f"n{i}_{j}": [i * spacing, j * spacing] for i in range(n) for j in range(n)}
    segs = []
    for i in range(n):
        for j in range(n):
            if i + 1 < n:
                segs.append({"id": f"h{i}_{j}", "a": f"n{i}_{j}", "b": f"n{i + 1}_{j}"})
            if j + 1 < n:
                segs.append({"id": f"v{i}_{j}", "a": f"n{i}_{j}", "b": f"n{i}_{j + 1}"})
    seats = []
    for k in range(n_seats):
        if rng.random() < 0.5:
            x, y = rng.uniform(0, (n - 1) * spacing), rng.randrange(n) * spacing - 3
        else:
            x, y = rng.randrange(n) * spacing - 3, rng.uniform(0, (n - 1) * spacing)
        seats.append({"id": f"b{k:04d}", "x": x, "y": y, "type": "bench"})
    side = (n - 1) * spacing
    poly = [[-50, -50], [side + 50, -50], [side + 50, side + 50], [-50, side + 50], [-50, -50]]
    return {"nodes": nodes, "segments": segs, "seats": seats, "service_polygon_xy": poly, "name": "stress grid"}


def bench(ds, trips, limits, label):
    p = Planner(ds)
    cold, warm = [], []
    for a, b in trips:
        for i, L in enumerate(limits):
            t = time.perf_counter()
            r = p.plan(ds.to_lonlat(*a), ds.to_lonlat(*b), L, [])
            ms = (time.perf_counter() - t) * 1000
            (cold if i == 0 else warm).append(ms)
            assert r["status"] in ("ok", "limit_unmet", "disconnected"), r["status"]
    print(
        f"{label}: {len(ds.seat_node)} eligible seats, {len(ds.graph.nodes)} nodes | "
        f"first request per trip median {statistics.median(cold):.1f} ms (max {max(cold):.1f}) | "
        f"warm slider reroute median {statistics.median(warm):.1f} ms (p95 {sorted(warm)[int(0.95 * (len(warm) - 1))]:.1f}, max {max(warm):.1f})"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", type=int, default=40)
    ap.add_argument("--seats", type=int, default=300)
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()
    limits = [400, 350, 300, 250, 200, 150, 120, 100, 80, 60]

    syn = load_synthetic()
    t = [((0, -8), (600, -8)), ((0, -8), (120, -8))]
    bench(syn, t, limits, "synthetic demo")

    t0 = time.perf_counter()
    ds = build_synthetic(stress_fixture(args.grid, args.seats))
    build_s = time.perf_counter() - t0
    print(f"stress grid build (attach + seat distance matrix): {build_s:.1f} s")
    rng = random.Random(1)
    side = (args.grid - 1) * 80
    trips = [((rng.uniform(0, side), rng.uniform(0, side)), (rng.uniform(0, side), rng.uniform(0, side))) for _ in range(8)]
    bench(ds, trips, limits, f"stress grid {args.grid}x{args.grid} (generated, not Flushing)")

    if args.live:
        live = load_live()
        pts = [(pl["lon"], pl["lat"]) for pl in live.places[:6]]
        from pyproj import Transformer

        tr = Transformer.from_crs("EPSG:4326", live.graph.crs, always_xy=True)
        xy = [tr.transform(*p) for p in pts]
        trips = [(xy[i], xy[j]) for i in range(len(xy)) for j in range(len(xy)) if i < j][:8]
        bench(live, trips, limits, "Flushing pilot")


if __name__ == "__main__":
    main()
