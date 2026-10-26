# Validation

There are two different kinds of checking. Keep them separate.

## 1. Automated tests (does the code do what it claims?)

Run from the repository root:

```bash
cd backend && python -m pytest -q          # routing, attachment, API, import pipeline
cd frontend && npm test                    # interface behavior (Vitest + Testing Library)
cd frontend && npm run build && npx playwright test   # browser flows against the real backend
python scripts/benchmark.py                 # timing
```

Results from the build session on 2026-10-26 are in the README under "Test results". Re-run them yourself and quote your own numbers.

## 2. Field validation (does the data match the street?)

Automated tests cannot tell you whether a bench in the data exists. That needs real observations. **No field checks have been done yet.** Do not quote accuracy numbers until you have them.

### Seat audit

1. After importing, open `GET /api/seats?bbox=…&mode=live_pilot&include_ineligible=true` (or the map) and pick a sample: for example every eligible seat on two blocks, plus 5 random ones. Write down how you picked them before you go, so the sample is not biased toward benches you know exist.
2. For each seat, visit (or use dated street-level imagery, and say which) and fill one row in a copy of `data/audit_template.csv`:
   * `kind` = `seat`, `seat_id_or_route` = the seat id from the app
   * `expected_from_app` = type, backrest, covered as shown in the app
   * `observed` = what is there; `matches` = yes / no / partly
3. For each seat you physically checked, add a row to `data/field_checks.csv` (`seat_id, checked_at, observed_status, notes, checker`), with `observed_status` = `present`, `missing` or `unusable`. Re-run the import. Missing seats become `unavailable` and are no longer used; present seats show "field-checked" with the date.
4. Report results as counts with the sample size, for example "N of M sampled seats were present as recorded", and say how the sample was chosen and on what date.

### Route audit

1. Pick 2 to 3 real trips inside the pilot outline. For each, record the app's route at one limit (print the summary).
2. Walk it. At each planned seat note whether it was there and usable. Note any leg where the real walk differed from the map (closed path, missing crosswalk, construction).
3. Record each trip as rows with `kind` = `route` in the audit CSV.

### Where Street View is used instead of a visit

Say so explicitly and give the imagery date shown in the viewer. Imagery can be years old.

## What not to claim

* Do not say a route is safe, accessible or step-free.
* Do not say a seat is available; even field-checked seats may be occupied.
* "No route within X m" is about mapped walkways and recorded seats only.
