> Update (26 October 2026, NYC): the planner (`nearby` mode) is New York City only. `scripts/update_nyc_data.py` writes OSM tiles, NYC DOT seating, the city outline and a prepared Flushing area to `data/nyc/`; `backend/app/data/nyc.py` and `nearby.py` build each trip's area from them in a background worker, with no network access. Place search (`/api/search`) is the only outside call. Descriptions below of pre-imported data refer to the retained synthetic/prepared-pilot paths.

# Architecture

```
 scripts/prepare_pilot.py  (run once, needs internet)
   OSM walk network (OSMnx/Overpass) ─┐
   OSM seating features ──────────────┼─> attach + rules + dedupe ─> data/pilot/
   NYC DOT Seating Locations (SODA) ──┘        seat distance matrix     graph.json.gz
                                                                         matrix.json.gz
                                                                         rest_route.sqlite
                                                                         manifest.json

 backend/  FastAPI (persistent process, no downloads while serving)
   app/data/dataset.py   load synthetic fixture (built in memory) or the pilot artifacts
   app/routing/graph.py  segments, directions, Dijkstra
   app/routing/attach.py snapping points to walkways, splitting segments
   app/routing/terminal.py  search on the terminal graph (limit, minimax, two-pass)
   app/routing/planner.py   one trip: attach, search, redraw, build the response
   app/main.py           HTTP API, optional static hosting of the built frontend

 frontend/  React + TypeScript + Vite + React Leaflet
   hooks/useRoutePlanner.ts  debounced requests, abort + "latest wins"
   components/RouteMap.tsx   Leaflet map (basemap optional)
   components/ResultCard.tsx status, metrics, itinerary, seat details, exclude
   components/PrintSummary.tsx  print-only text summary
```

## Data flow for one request

1. Browser sends `POST /api/route` with start, destination, limit, excluded seat ids and dataset mode.
2. Planner checks the service outline, attaches both points (virtual, per request), and reuses cached start/destination searches if the same trip was asked before.
3. It builds the terminal graph from cached seat-to-seat distances, runs the search, re-traces the legs and returns GeoJSON plus metrics computed on the server.
4. The browser shows the result only if it answers the newest request.

## Modes

* `synthetic_demo`: fictional grid in `data/fixtures/synthetic_demo.json`, built at startup through the same attach/rules/matrix code. Drawn without a basemap.
* `live_pilot`: Flushing artifacts in `data/pilot/`. The server checks the graph fingerprint, rules hash and matrix against the manifest. Any mismatch or missing file means `data_unavailable`. Live mode never falls back to synthetic data.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | which modes are ready |
| `GET /api/config` | slider bounds, per-mode outline, dataset version, counts, saved trips; synthetic mode also returns its street network for drawing |
| `GET /api/seats?bbox=minLon,minLat,maxLon,maxLat&mode=…&include_ineligible=` | seat records for display |
| `GET /api/places?q=…&mode=…` | search the imported landmark list |
| `POST /api/route` | plan one route (request/response in `app/models/schemas.py`) |

Route request: `origin {lat, lon}`, `destination {lat, lon}`, `max_gap_m` (50 to 500), `excluded_seat_ids[]`, `dataset_mode`, optional `client_request_id`, optional `hypothetical_seats[]` (up to 3, planning experiment, never stored).

Route response: `request_id, status, message, dataset_version, data_mode, coverage, requested_max_gap_m, total_distance_m, longest_gap_m, minimum_required_gap_m, rest_count, extra_distance_m, comparison_distance_m, route_geojson, comparison_geojson, stops[], legs[], over_limit_legs[], warnings[], snapped_endpoints, limitation_note`, plus `hypothetical` (benches used and a without-benches summary) when hypothetical benches were sent. On any non-route status the route fields are null/empty.

## Caching

* Seat-to-seat matrix: built once (import script for the pilot, startup for synthetic). Keyed by graph fingerprint + eligibility rules hash.
* Per-trip searches: in-memory LRU (64 trips) keyed by dataset version, rules hash and projected endpoint coordinates.
* Seat exclusions do not invalidate caches; they just remove terminals before the search on H.

## Privacy

Request bodies are not logged (uvicorn runs with `--no-access-log`; errors are logged without endpoints). Only the slider value is stored in the browser. Geolocation is requested only after the button is pressed. The tile server receives viewport requests when the basemap is on.
