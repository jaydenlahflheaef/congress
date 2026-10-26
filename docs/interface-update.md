# Planner update — 26 October 2026

## What changed

The main page now has a single real-world planner: From, To, preferred rest distance, and Find my walk. Search accepts places/addresses worldwide through Photon on explicit submission. Choosing a new place clears old routing results. Location remains opt-in. On phones, Plan walk and View map shortcuts make the same trip easier to navigate; this is still a web app, not a compiled native iOS app.

The fictional graph is available through How it works → Try an example walk (`/#example`). It is clearly labeled and never used when a real-data request fails. The prepared Flushing dataset still exists for API/research use but is no longer a mode users have to choose. Details about individual benches, map settings, and hypothetical benches are collapsed until needed.

New backend endpoints:

- `GET /api/search?q=…`: bounded, cached Photon search; no keystroke autocomplete.
- `POST /api/areas`: origin/destination coordinates start or reuse preparation of a real OSM neighborhood. Returns `loading`, `ready`, `busy`, or `error`.
- `GET /api/areas/{dataset_id}`: progress, or area metadata and eligible seat records when ready.
- `POST /api/route` accepts `dataset_mode: nearby` and `dataset_id`; the existing route engine performs the computation. Missing/expired areas return `data_unavailable`.

The neighborhood envelope is rounded outward, projected into a local meter-based coordinate system, and buffered by 500 m for detours. Endpoints must be within 3 km geodesic distance, between latitudes ±85°, and not cross the date line. Areas over 20,000 nodes or 600 eligible seats fail explicitly, without silently removing seats. One worker loads areas; at most two requests are queued/running. Four planners stay in memory, twelve artifacts on disk, and data is refreshed after seven days. Persistent single-process hosting is required; the old Vercel serverless instructions do not apply.

## Verification

- Python routing/API/data tests: 752 passed on the local Python 3.14 environment.
- Frontend unit tests: 25 passed, including worldwide search, no keystroke network traffic, late-response rejection, real-area reuse across slider changes, seat exclusion, and no fake fallback.
- TypeScript and Vite production build: passed.
- Chromium browser suite: 15 passed, 1 skipped (desktop skips the phone-only collapse check). Includes mobile width, controls, no-data flow, example feasible/fallback/disconnected flows, seat exclusion, print view, tile failure, and hypothetical bench behavior.
- Visual inspection: desktop and phone-sized layouts. This is not an actual iPhone/Safari or VoiceOver test.

## Live Boston smoke check (not a field check)

A public walking area around Boston Public Garden was downloaded from OpenStreetMap. The imported graph contained 5,206 nodes and 517 eligible seat records. For the same public test endpoints, the actual router returned:

| Rest limit | Walking distance | Longest stretch | Planned rests |
| --- | --- | --- | --- |
| 400 m | 278.34 m | 278.34 m | 0 |
| 150 m | 324.34 m | 143.61 m | 2 |
| 100 m | 337.96 m | 90.99 m | 4 |

Measured local routing calls after import took approximately 13 ms, 2 ms, and 1 ms respectively. The first download took several minutes; public Overpass availability is variable. These measurements are one smoke check, not a performance guarantee or proof that every location works.

No bench availability, public access, crossing, surface, or medical suitability was verified in person. Existing conservative attachment checks remain in use; ambiguous/off-network points can still require moving a pin. Search results can refer to the center of a park or building rather than its entrance. Dynamic areas currently use OSM seating only; the separate prepared Flushing API can additionally use NYC DOT records.

## iPhone next step

See `DEPLOY.md` for the Capacitor path: host the Python API, package the existing React build, configure the API origin and permissions, and test through Xcode. No app has been submitted, deployed, or signed in this update.
