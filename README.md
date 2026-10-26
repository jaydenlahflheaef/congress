# Rest Route

Rest Route plans walks around places to sit. You choose a start, a destination and the **maximum distance you want to walk between rests**. It finds the shortest mapped walking route that reaches a recorded seat often enough. If no route can meet your limit, it shows the route whose longest stretch without a seat is as short as possible, says by how much it exceeds your limit, and highlights those stretches.

The main planner now searches worldwide and loads a small real OpenStreetMap walking area around the chosen trip. Endpoints can be up to 3 km apart; walking distance may be longer. The original fictional example is available under **How it works → Try an example walk**, and is never substituted for real data.

A rest resets the distance count in the plan. That is a planning preference, not a medical estimate. Results are limited to mapped paths and recorded seats.

## Status

| Part | State |
|---|---|
| Routing engine (limit search, two-pass minimax fallback, leg redraw) | Done, tested |
| Synthetic demo (400 / 150 / 100 m slider demo, disconnected case) | Done, tested |
| HTTP API | Done, tested |
| Web app (map, slider, results, exclude seat, print, How it works) | Done, tested in Chromium |
| Import pipeline for Flushing (OSM + NYC DOT) | Written and tested **offline only**. Must be run on a machine with internet access (see below). Until then, the retained `live_pilot` API reports `data_unavailable`. This does not affect the new on-demand planner. |
| Field validation | Not done. Template and process in `docs/validation.md` |
| Deployment | Requires a persistent Python process for on-demand areas. See `DEPLOY.md`; no deployment performed |
| Optional "propose a bench" planning experiment | Built for single trips (up to 3 hypothetical benches, with/without comparison). The "how many destinations become reachable" comparison is not built |

## Current interface and data loading

Start with From, To, and your preferred distance between rests. Press Enter or the search icon to search; choose a result, then **Find my walk**. New areas load in the background with progress and can take several minutes when providers are busy. Subsequent slider changes reuse the loaded graph. Missing map data produces a clear error, never fictional benches. Comparison lines, street-map visibility, and hypothetical benches live under **Map options & experiments**.

Area artifacts are cached in `data/areas/` (ignored by Git). Four areas stay in memory, up to twelve on disk, and artifacts older than seven days are refreshed. The on-demand source is OSM; NYC DOT data is currently used only by the retained prepared-pilot API. Field validation is still separate.

## Quick start

Requirements: Python 3.11+ (tested on 3.13), Node.js 20+ (tested on 22).

```bash
# 1. Backend
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 2. Frontend (second terminal), dev server with hot reload
cd frontend
npm ci
npm run dev            # open http://localhost:5173  (calls the backend through /api)
```

Single-origin mode (what you would deploy): `cd frontend && npm run build`, then run the backend; it serves `frontend/dist` at http://localhost:8000.

Optional Docker: `docker compose up --build` (local only).

For hosting and the iPhone/Capacitor path, see **`DEPLOY.md`**. The on-demand area loader needs a persistent server; the former serverless recipe no longer applies.

## Importing the Flushing pilot

The main planner downloads OSM data around each requested area automatically. The separate original Flushing + NYC DOT preparation pipeline remains available for research/API clients. To create those artifacts:

```bash
cd backend && source .venv/bin/activate && cd ..
python scripts/prepare_pilot.py
```

It downloads the OSM walking network and seating for the area in `data/pilot_area.json` (plus a 400 m buffer), downloads NYC DOT Seating Locations (dataset `esmy-s8q5`), applies the seat rules, and writes `data/pilot/` (graph, distance cache, SQLite, manifest). Typical run time is a few minutes; most of it is the Overpass download. Restart the backend afterwards. The `live_pilot` API dataset becomes available, and `data/pilot/manifest.json` lists record counts, excluded seats by reason, merges and warnings.

Check before using it:

1. Inspect the `live_pilot` service polygon from `/api/config` against the intended area. If needed, edit `data/pilot_area.json` and re-run. The main interface no longer asks users to select a dataset.
2. Look at `excluded_by_reason` in the manifest. Many "Ambiguous walkway attachment" seats means you may want curated attachments (`data/curated_attachments.json`).
3. Edit `data/pilot_trips.json` so the saved trips match landmark names that were imported (see `GET /api/places?q=…&mode=live_pilot`).

If something is blocked:

* NYC Open Data unreachable: download the CSV from the dataset page and run `python scripts/prepare_pilot.py --dot-csv Seating_Locations.csv`.
* Overpass busy or rate-limited: wait and retry. After one success, `data/pilot/raw/` has saved copies; reuse them with `--osm-graphml data/pilot/raw/osm_walk.graphml --osm-seats-geojson data/pilot/raw/osm_seats.geojson --osm-places-geojson data/pilot/raw/osm_places.geojson`. (Copy `raw/` somewhere first, since a re-run replaces `data/pilot/`.)
* `--skip-dot` builds with OSM seats only; the manifest records that.

Field checks: add real observations to `data/field_checks.csv` and re-run (see `docs/validation.md`).

## Tests

```bash
cd backend && python -m pytest -q
cd frontend && npm test
cd frontend && npm run build && npx playwright install chromium && npx playwright test
python scripts/benchmark.py
```

### Results from the build session (2026-10-26, 2-vCPU Linux cloud workspace)

* Backend `pytest`: **740 passed**. Includes 500 brute-force oracle comparisons on random terminal graphs, the single-label counterexample, monotonicity properties, attachment/splitting, directed and parallel edges, the API, and an offline end-to-end run of the import script on hand-made OSM/DOT-shaped inputs.
* Frontend `vitest`: **20 passed** (stale-response guard, debounce, result states, exclusion renumbering, print summary, localStorage, hypothetical-bench comparison).
* Playwright (Chromium headless, desktop + Pixel 7 profiles): **12 passed, 1 skipped** (the mobile-only test is skipped in the desktop profile). Covers the feasible, limit-unmet, no-data and disconnected flows, tile failure, seat exclusion, print view, keyboard slider, placing a hypothetical bench, and no page errors when switching data sets.
* `tsc` type-check and `vite build`: pass.
* Benchmark (`scripts/benchmark.py`):
  * Synthetic demo: warm slider reroute median 0.5 ms.
  * Generated 40x40 stress grid with 298 seats (not Flushing): first request per trip median 15 ms, warm reroute median 10 ms (p95 16 ms).
  * Generated 60x60 grid with 987 seats: warm reroute median 29 ms (p95 94 ms); building its seat distance cache took 14 s.
  * The real Flushing pilot has not been measured. Run `python scripts/benchmark.py --live` after importing.

## Project layout

```
backend/app/routing/   graph, attachment, terminal-graph search, planner
backend/app/data/      seat model and rules, source adapters, dataset loading
backend/app/main.py    FastAPI app
backend/tests/         pytest suites
frontend/src/          React app (components, hooks, api, tests)
frontend/e2e/          Playwright flows
scripts/               prepare_pilot.py, benchmark.py
data/fixtures/         synthetic demo (fictional)
data/pilot_area.json   pilot outline; data/pilot/ is created by the import
docs/                  architecture, algorithm, data sources, validation, demo steps
```

## Known limitations

* Each trip loads a bounded neighborhood with a 500 m routing buffer. Optimality and "not possible" claims apply only to that loaded map and its eligible seat records, not the whole city. Very dense areas (over 600 eligible seats or 20,000 graph nodes) are rejected explicitly.
* Seat data can be incomplete or outdated, and seats may be occupied. Nothing has been field-checked yet.
* No checks of curbs, slopes, crossings, surfaces, lighting or safety. The app never calls a route safe, accessible or step-free.
* Stairs are excluded only where OSM tags them as steps.
* In the fallback, once the smallest possible longest leg is found, the route minimizes total distance; other legs may also exceed your limit even where an extra rest could shorten them (see `docs/algorithm.md`).
* No walking-time estimates (no pace is assumed).
* Worldwide place/address search uses Photon on explicit submission. Result coordinates can be building centers; unresolved walkway attachment asks users to adjust the map pin.
* The default basemap uses the OpenStreetMap tile server and needs internet; the synthetic demo does not.
* The service area coordinates in `data/pilot_area.json` are approximate and should be checked on the map.

## Data and licenses

Map data © OpenStreetMap contributors (ODbL). Seating data from NYC DOT via NYC Open Data. Details, field mappings and dependency licenses: `docs/data_sources.md`.

## More

* How the algorithm works: `docs/algorithm.md`
* Architecture and API: `docs/architecture.md`
* Field validation process: `docs/validation.md`
* Demonstration steps: `docs/demo_script.md`
* Deployment: `DEPLOY.md`
* AI assistance: `AI_USAGE.md`
