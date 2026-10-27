# AI usage disclosure

This project was built with substantial help from an AI assistant (Claude, by Anthropic). This file records what the AI did so the project can be described honestly. The student should complete and correct the sections marked **(student)**.

## What the AI did (build session, 2026-10-26)

* Wrote the implementation from a written specification ("Rest Route build brief") provided by the student:
  * Backend: walking-graph model, point attachment and segment splitting, the terminal-graph searches (limit-constrained Dijkstra, minimax Dijkstra, two-pass fallback), the trip planner, seat eligibility rules and de-duplication, dataset loading, and the FastAPI endpoints.
  * Import pipeline: `scripts/prepare_pilot.py` and the OSM / NYC DOT adapters. The AI looked up the NYC DOT dataset id and its column list on NYC Open Data and data.gov during the session.
  * Frontend: React components, the request-sequencing hook, map rendering, print view, How it works page, styling.
  * Tests: pytest suites (including the brute-force oracle and the lexicographic counterexample), Vitest/Testing Library tests, Playwright browser flows, and the benchmark script.
  * The optional "propose a bench" planning experiment (backend and UI).
  * Synthetic demo fixture (fictional streets and seats) and the documentation in `docs/`.
* Ran the tests and benchmark in a cloud workspace and reported the results in the README.
* Prepared the Vercel deployment configuration (`index.py`, `pyproject.toml`, `vercel.json`, `DEPLOY.md`) and tested it in a simulated bundle.
* Could not run the full data import, because that workspace could not reach the Overpass API. The NYC DOT download was run for real once; the OSM part was tested only with small hand-made inputs shaped like OSM data.

## What the AI did not do

* No field checks, user interviews, or accuracy measurements were done or invented.
* The original build session included no real data. The NYC update below added real map and seating data, downloaded and processed by the AI from public sources; none of it has been field-checked.
* The AI did not deploy anything.

## Decisions made by the student **(student)**

_Fill in: the problem choice, the specification, which features to keep or cut, the pilot area, and any changes you made after reviewing the code._

## Code the student wrote or changed **(student)**

_Fill in after reviewing. List files or functions you wrote or substantially changed yourself._

## How the student checked the AI's work **(student)**

_Fill in: for example, which parts of `docs/algorithm.md` you can explain without notes, tests you re-ran, field checks you did._

## Codex update — 2026-10-26

At the owner’s request, Codex simplified the planner, moved the fictional example into How it works, added worldwide explicit Photon search and background OSM neighborhood preparation, updated mobile layout and tests, and documented the persistent hosting/iOS path. Existing routing math and seat attachment rules were reused. Real-data verification used a public Boston walking area; it is not a field check or evidence of global coverage. The owner has not been credited with unverified contributions. See docs/interface-update.md for checks executed.

## Claude update (NYC data, Home Screen app) — 2026-10-26

At the owner's request, Claude (Anthropic) made the planner New York City only and removed its dependence on live map servers, after the public Overpass API was found to be at capacity during this session:

* Wrote `scripts/update_nyc_data.py`, which downloads the BBBike.org New York OpenStreetMap extract, the NYC city outline and all NYC DOT seating records, and writes tiles and a prepared downtown Flushing area to `data/nyc/`. Ran it and committed the output.
* Backend: areas are now cut from those tiles (`backend/app/data/nyc.py`, `nearby.py`) with NYC DOT seats merged in; trips and search are limited to NYC; indoor/underground walkways and unconnected walkway scraps are left out after testing ten real trips across the five boroughs; building and park search results are moved to the nearest walkway; areas dropped from memory reload from disk.
* Frontend: NYC wording and map view, one-tap Flushing example walks, a Google Maps walking-directions link for each stretch, Home Screen app manifest and icons, and a fix for a "-0 m" display.
* Replaced the Vercel setup with a Render Blueprint and a slimmer server image; updated README, DEPLOY.md and docs; added and updated tests (backend 756, frontend 28, Playwright 18 passed).

The AI did not deploy the app, did not test on a real iPhone, and did not change the routing algorithm. The ten-trip check is a software smoke test, not a field check.

## Claude update (map-first interface, Google map) — 2026-10-26

At the owner's request, Claude rebuilt the interface around a full-screen Google map (`MapView.tsx`, using @vis.gl/react-google-maps) with a floating search card and a draggable bottom sheet that becomes a side panel on wide screens (`Sheet.tsx`), replacing the Leaflet/OpenStreetMap tile map. The owner created the Google Maps API key; it is read by the server from `GOOGLE_MAPS_API_KEY` and is not stored in the repository. Routing, data and results logic were not changed. Tests were updated for the new map (Playwright runs against the real Google map); screenshots were checked at iPhone and desktop sizes in Chromium, not on a real iPhone.

