# How the router works

This page explains the routing algorithm in plain language, then precisely. The code is in `backend/app/routing/`.

## The question

You give a start, a destination and a number L, the most you want to walk before sitting down. We want the **shortest walk** from start to destination such that **every stretch between rests is at most L meters**. A rest can only happen at a recorded seat.

If that is impossible, we want the walk whose **worst stretch is as short as possible**, and among those, the shortest one.

## Step 1: the walking map is a graph

Every sidewalk, footpath or street piece between two corners is an *edge* with a length in meters. Corners and path ends are *nodes*. This is the graph **G**.

* Lengths come from coordinates in meters (UTM zone 18N for New York). We never treat latitude/longitude degrees as meters, because a degree of longitude is shorter than a degree of latitude at New York's latitude.
* Each edge records which directions you may walk. Almost all are two-way. A path tagged as one-way for pedestrians keeps only one direction.
* Two different paths between the same two corners stay separate (each keeps its own shape), so the route is drawn along the path actually used.

## Step 2: attach seats and endpoints

A bench is usually a few meters off the walkway. We find the nearest walkway, split it at the closest point, and add a short **connector** from that point to the bench. The connector length counts in the route.

* No walkway within 20 m: the seat is shown but not used.
* Two different walkways almost equally close, and far apart on foot (for example sidewalks on opposite sides of a road): the attachment is **ambiguous**, so the seat is not used unless someone adds a curated attachment in `data/curated_attachments.json`.

Your start and destination are attached the same way, but only "virtually" for your request (the shared graph is not changed). If either is more than 60 m from any walkway, we refuse and say so instead of moving your point silently. The snapped point and the snap distance are shown.

## Step 3: the terminal graph H

Now make a much smaller graph **H** whose nodes are just: start, destination, and every eligible seat ("terminals"). An arrow u → v means "walk from u to v without resting"; its weight d(u, v) is the shortest walking distance in G.

* Seat-to-seat distances do not depend on the slider, so they are computed once when the data loads (one Dijkstra search per seat).
* For each trip we do one forward search from the start and one backward search to the destination. Those are cached, so moving the slider only re-runs the small search on H.
* Walking past a seat does not count as resting. Choosing a seat as a stop in H means you plan to rest there.
* Distances inside H are stored as whole micrometers (integers). That makes "exactly 150 m" and ties exact instead of depending on floating-point rounding.

## Step 4A: shortest route within the limit

Remove every arrow longer than L. Run ordinary Dijkstra on what is left. If the destination is reachable, that path is the shortest route whose every leg (including the first leg from the start and the last leg to the destination) is at most L. A direct walk that is already short enough needs no rests.

Ties: equal total distance is broken by fewer legs, then by the smaller terminal id, so the same input always gives the same route.

## Step 4B: when the limit cannot be met

Let B\* be the smallest possible "longest leg" over all routes:

> B\* = min over routes P of (max leg length in P)

1. **Minimax Dijkstra** finds B\*: like Dijkstra, but the value carried along a path is the largest leg so far, `max(b(u), d(u, v))`, instead of the sum.
2. Keep only arrows with d ≤ B\* and run ordinary Dijkstra for total distance.

The result is the shortest route among all routes whose worst leg is as small as possible. We report B\*, how far it exceeds your limit, and highlight every leg over your limit.

**Why two passes?** It is tempting to do it in one search that keeps a single (worst leg, total) pair per node. That is wrong. Example (also a unit test): two ways reach X, one with worst leg 5 and total 5, one with worst leg 3 and total 6. A one-label search keeps the second (better worst leg). But the only way on from X has a leg of 10, which makes both worst legs 10, and now the first prefix (total 15) beats the second (16). The one-label search already threw it away.

**Known behavior:** once B\* is fixed, the second pass minimizes total distance. Other legs can also be over your limit even if an extra rest could have shortened them, because the algorithm only promises the smallest worst leg and then the shortest total. A future version could add a third tie-breaker (least total distance over the limit).

## Step 5: other outcomes

| Status | Meaning |
|---|---|
| `ok` | Every leg ≤ your limit |
| `limit_unmet` | Connected, but no route meets the limit; fallback shown |
| `disconnected` | No walking path connects start and destination in the mapped network |
| `unsupported_area` | Start or destination is outside the pilot outline |
| `endpoint_unresolved` | A point is too far from any walkway to attach |
| `data_unavailable` | The chosen dataset is not imported or failed its checks |
| `error` | A software or connection error. Never shown as "no route" |

All claims ("shortest", "not possible") are only about the loaded map and the eligible seat records.

## Step 6: drawing the route

Each leg is re-traced in G along the real walkway shapes (plus connectors). We check that the re-traced length equals the planned distance. Straight lines are only used for the short connectors between a seat and its walkway.

## Optional: hypothetical benches

The "Propose a bench" panel lets you place up to 3 hypothetical benches for one request. Each one is attached to the nearest walkway within 15 m and placed on it (connector length 0), which is the same as splitting that walkway at that point. Two searches per bench (forward and reverse) give its distance to and from every other terminal, and those arcs are added to H for this request only. The response shows the route with the benches and a summary of the same search without them. Hypothetical benches never enter the seat database. A unit test checks that a hypothetical bench gives the same result as a real bench recorded at the same spot.

## Checks that the code is right

`backend/tests/test_terminal.py` compares the search against a brute-force oracle that lists every simple path on 300 small random graphs and computes the correct answers directly. Other tests cover the counterexample above, exact-threshold legs, monotonicity (a looser limit never makes the best route longer; adding a seat never makes the best worst-leg larger), one-way paths, parallel paths, connectors and units.
