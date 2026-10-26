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
* No real Flushing data is included in this repository unless the student runs the import.
* The AI did not deploy anything.

## Decisions made by the student **(student)**

_Fill in: the problem choice, the specification, which features to keep or cut, the pilot area, and any changes you made after reviewing the code._

## Code the student wrote or changed **(student)**

_Fill in after reviewing. List files or functions you wrote or substantially changed yourself._

## How the student checked the AI's work **(student)**

_Fill in: for example, which parts of `docs/algorithm.md` you can explain without notes, tests you re-ran, field checks you did._

## Codex update — 2026-10-26

At the owner’s request, Codex simplified the planner, moved the fictional example into How it works, added worldwide explicit Photon search and background OSM neighborhood preparation, updated mobile layout and tests, and documented the persistent hosting/iOS path. Existing routing math and seat attachment rules were reused. Real-data verification used a public Boston walking area; it is not a field check or evidence of global coverage. The owner has not been credited with unverified contributions. See docs/interface-update.md for checks executed.
