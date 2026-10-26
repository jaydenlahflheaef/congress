# Demonstration steps

A click-by-click run of the app for recording or for judges. Narration is yours to write; this only lists what to show.

## Before recording

* Start the server (`cd backend && uvicorn app.main:app --port 8000`) with the built frontend, or the dev setup from the README. Open http://localhost:8000.
* Clear the browser's site data so the slider starts at its default.
* If the Flushing import has run, check the map outline and a couple of seats against Street View first (see `docs/validation.md`).

## Part A: the slider, on the synthetic demo (always works offline)

1. Choose **Demo (synthetic)**. Point out the purple "Demo mode, not a real place" note.
2. Saved demo trips → **Library to Clinic (slider demo)**. The slider jumps to 400 m.
   * Expected: "Within your selected limit (400 m)", 622 m total, 1 planned rest on Main St.
3. Type **150** (or drag). Expected: route switches to the back street, 904 m, 8 rests, longest leg 136 m, +288 m vs the shortest walk (gray dotted line).
4. Type **100**. Expected: "Limit not met", "The smallest achievable longest gap is 136 m", two amber dashed legs. Click an amber leg in the itinerary to zoom to it.
5. Tap one of the gray dashed seat markers on Main St: "Not counted: Leaning bar…". This is why Main St fails at 150 m even though it has street furniture every 150 m.
6. Back at 400 m, press **Exclude this seat** on the Main St bench. Expected: recalculates to 868 m via the back street. Press **Restore**.
7. Saved demo trips → **Library to River Walk Overlook**: "No connected walking route". The river bench is 43 m from the clinic but there is no bridge in the map.
8. Back to the slider demo at **100 m**. Open **Propose a bench (planning experiment)**, press **Place a hypothetical bench**, and click on the back street in the middle of the long amber stretch (between seats 4 and 5). Expected: "Within your selected limit (100 m)", a purple dashed stop, and a with/without table (without: limit not met, longest leg 136 m). Press **Clear all** to go back.
9. **Print route summary** (or the browser's print preview) to show the text-only plan.

## Part B: Flushing pilot (after running the import)

1. Choose **Flushing pilot**. The dashed outline shows coverage.
2. Pick a saved trip or set start and destination with **Set on map** inside the outline.
3. Repeat the 400 → 150 → 100 m slider changes and read the real numbers off the screen.
4. Open one planned seat: source (OpenStreetMap or NYC DOT), type, backrest, "On record only; not field-checked" unless you have done field checks.
5. Open **How it works** for the limitations.

## Part C: under the hood (optional)

* `docs/algorithm.md`: terminal graph, minimax Dijkstra, two-pass fallback, and the counterexample showing why one search is not enough.
* Run `python -m pytest -q` in `backend/` to show the test count, and `python scripts/benchmark.py` for timing.

## If something goes wrong live

* No internet: Part A still works (no basemap needed).
* Tiles fail: the route lines and text itinerary still work; a notice appears on the map.
