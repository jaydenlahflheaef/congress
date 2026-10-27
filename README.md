# EzWay

(Formerly Rest Route. The code, Render service and data files still use `rest-route` in places.)

EzWay plans walks around places to sit. You choose a start, a destination and the **maximum distance you want to walk between rests**. It finds the shortest mapped walking route that reaches a recorded seat often enough. If no route can meet your limit, it shows the route whose longest stretch without a seat is as short as possible, says by how much it exceeds your limit, and highlights those stretches.

EzWay covers **New York City**. Each trip uses a small walking area cut from OpenStreetMap and NYC DOT data that is saved in this repository, so planning never waits on an outside map server. Endpoints can be up to 3 km apart; walking distance may be longer. Downtown Flushing is prepared ahead of time and opens instantly. The original fictional example is available under **How it works → Try an example walk**, and is never substituted for real data.

The interface works like Google Maps: a full-screen Google map, a search card for the start and destination, and a sheet at the bottom (a side panel on wide screens) with the rest-distance slider and the route. On a phone, EzWay installs as a Home Screen app (Safari → Share → Add to Home Screen). **Start** and the button on each stretch open Google Maps turn-by-turn walking directions to the next rest stop.

A rest resets the distance count in the plan. That is a planning preference, not a medical estimate. Results are limited to mapped paths and recorded seats.

## Status

| Part | State |
|---|---|
| Routing engine (limit search, two-pass minimax fallback, leg redraw) | Done, tested |
| Synthetic demo (400 / 150 / 100 m slider demo, disconnected case) | Done, tested |
| HTTP API | Done, tested |
| Web app (map, slider, results, exclude seat, print, How it works) | Done, tested in Chromium |
| NYC data (OSM walkways and seats from an extract, NYC DOT seating, city outline, prepared Flushing area) | Built by `scripts/update_nyc_data.py` and committed (OSM extract dated 2026-10-24, NYC DOT dataset updated 2026-10-13) |
| Original Flushing import (`scripts/prepare_pilot.py`, Overpass) | Kept for the `live_pilot` API only. Not run; that API reports `data_unavailable`. The planner does not use it |
| Field validation | Not done. Template and process in `docs/validation.md` |
| Deployment | Docker image + Render Blueprint (`render.yaml`). See `DEPLOY.md` |
| Map-first interface (Google map, bottom sheet / side panel) | Done; tested in Chromium at phone and desktop sizes with the real Google map, not yet on a real iPhone |
| Home Screen app (iPhone/Android) | Manifest and icons added; tested in Chromium, not yet on a real iPhone |
| Optional "propose a bench" planning experiment | Built for single trips (up to 3 hypothetical benches, with/without comparison). The "how many destinations become reachable" comparison is not built |

## Current interface and data loading

Start with From, To, and your preferred distance between rests, or tap one of the example walks in Flushing. Press Enter or the search icon to search New York City; choose a result, then **Find my walk**. A search result more than 40 m from any walkway (the middle of a large building or park) is moved to the nearest walkway within 250 m. Trips outside the five boroughs are refused with a plain message. Subsequent slider changes reuse the loaded area. Missing map data produces a clear error, never fictional benches. Comparison lines, street-map visibility, and hypothetical benches live under **Map options & experiments**.

New areas are built in a background worker from `data/nyc/` (usually 1 to 5 seconds on a laptop; longer on a small server). Built areas are cached in `data/areas/` (ignored by Git). Four areas stay in memory, up to twelve on disk, and areas older than seven days are rebuilt. An area dropped from memory is reloaded from disk when it is used again. Field validation is still separate.

### NYC data

`scripts/update_nyc_data.py` writes everything in `data/nyc/`:

* `boundary.json`: the city outline (OpenStreetMap via Nominatim), widened by about 300 m.
* `dot_seating.json.gz`: all NYC DOT Seating Locations records (dataset `esmy-s8q5`).
* `osm/`: walkways and seating features from the BBBike.org New York OpenStreetMap extract, cut into about 450 tiles (25 MB). Stairs, private paths, indoor and underground passages are left out; at build time, walkway pieces of fewer than 50 nodes that connect to nothing else are dropped.
* `seeds/flushing.json.gz`: the downtown Flushing area (`data/pilot_area.json`) built ahead of time, with the example trips in `data/pilot_trips.json`.

To refresh it (about a minute, plus a 150 MB download into the ignored `data/nyc/raw/`):

```bash
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python scripts/update_nyc_data.py            # or --only dot,seed, or --pbf FILE
```

Commit the changed files in `data/nyc/`. Built areas from older data are not reused, because the tile version is part of each area's cache key.

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

For hosting on Render and installing on an iPhone, see **`DEPLOY.md`**.

## The original Flushing import (optional)

The planner does not need this. The separate original Flushing + NYC DOT preparation pipeline, which downloads from the Overpass API, remains available for the `live_pilot` API. To create those artifacts:

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

### Results after the NYC update (2026-10-26, macOS, Python 3.14)

* Backend `pytest`: **756 passed** (adds tile-based area building, NYC-only trips and search, the prepared Flushing area, reloading evicted areas).
* Frontend `vitest`: **28 passed**. Playwright (desktop + Pixel 7, with the real Google map): **18 passed, 1 skipped**, including the Flushing example walk on the real committed data, placing a hypothetical bench by tapping the Google map, the bottom sheet, and the Home Screen manifest. The browser tests remove the key from Google's requests, so the map runs in Google's keyless development mode (darkened, with a watermark, and without EzWay's map style); no key is needed to run them.
* The server also ran from a clean Python 3.13 environment with only `backend/requirements-server.txt`: peak memory about 320 MB with Flushing plus four built areas.

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
scripts/               update_nyc_data.py, prepare_pilot.py, benchmark.py
data/nyc/              NYC outline, OSM tiles, NYC DOT seating, prepared Flushing area
data/fixtures/         synthetic demo (fictional)
data/pilot_area.json   downtown Flushing outline (prepared area and original import)
docs/                  architecture, algorithm, data sources, validation, demo steps
```

## Known limitations

* New York City only. Each trip loads a bounded neighborhood with a 500 m routing buffer. Optimality and "not possible" claims apply only to that loaded map and the benches used, not the whole city. In very dense areas (more than 600 usable benches) the benches are thinned: the best are kept first (backrest, real benches, NYC DOT records) and any bench closer than a growing spacing (10 m up to 200 m) to one already kept is skipped, until 600 or fewer remain. The page says how many were skipped and the spacing, and the manifest records it. Areas with more than 40,000 walkway nodes are still rejected, and a dense area can take 15 s or more to build.
* Seat data can be incomplete or outdated, and seats may be occupied. Nothing has been field-checked yet.
* No checks of curbs, slopes, crossings, surfaces, lighting or safety. The app never calls a route safe, accessible or step-free.
* Stairs are excluded only where OSM tags them as steps. Indoor and underground passages are excluded, so routes never go through stations or buildings.
* With a strict limit, the shortest route that meets it can be much longer than the direct walk where benches are sparse (for example 2.2 km instead of 565 m from Penn Station to Macy's at 250 m). The "Added for rests" figure shows the difference.
* The map data is a dated snapshot (see `data/nyc/osm/meta.json`); new benches or paths appear only after `update_nyc_data.py` is re-run.
* Google Maps chooses its own streets between rest stops, which can differ from the measured route.
* In the fallback, once the smallest possible longest leg is found, the route minimizes total distance; other legs may also exceed your limit even where an extra rest could shorten them (see `docs/algorithm.md`).
* No walking-time estimates (no pace is assumed).
* NYC place/address search uses Photon on explicit submission. Building and park results are moved to the nearest walkway, which is not necessarily the entrance; users can move the pin.
* The map is Google Maps and needs internet and a key (`GOOGLE_MAPS_API_KEY`, see DEPLOY.md); without them the route list still works. The synthetic demo hides the Google map and draws its own streets.
* The service area coordinates in `data/pilot_area.json` are approximate and should be checked on the map.

## Data and licenses

Map data © OpenStreetMap contributors (ODbL), via the BBBike.org New York extract. Seating data from NYC DOT via NYC Open Data. Details, field mappings and dependency licenses: `docs/data_sources.md`.

## More

* How the algorithm works: `docs/algorithm.md`
* Architecture and API: `docs/architecture.md`
* Field validation process: `docs/validation.md`
* Demonstration steps: `docs/demo_script.md`
* Deployment: `DEPLOY.md`
* AI assistance: `AI_USAGE.md`
