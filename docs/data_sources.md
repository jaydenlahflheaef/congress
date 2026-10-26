# Data sources and licensing

## OpenStreetMap (walking network and seating)

* For the planner: the BBBike.org New York extract (https://download.bbbike.org/osm/bbbike/NewYork/), read by `scripts/update_nyc_data.py` with pyosmium and saved as tiles in `data/nyc/osm/`. The extract date is in `data/nyc/osm/meta.json`. The same walk filter is applied in Python (`is_walkable_way`), plus two NYC rules: ways tagged `indoor` (other than `indoor=no`) or with a negative `level` are left out, and when an area is built, walkway pieces of fewer than 50 nodes that connect to nothing else are dropped.
* The city outline (`data/nyc/boundary.json`) is OpenStreetMap's New York City boundary from Nominatim, simplified and widened by about 300 m.
* For the original `live_pilot` import only: retrieved by `scripts/prepare_pilot.py` through OSMnx (Overpass API).
* License: Open Database License 1.0. Attribution "© OpenStreetMap contributors" is shown on the map and on the How it works page. If you publish the imported data files, they remain under ODbL. See https://www.openstreetmap.org/copyright.
* Walk filter (`WALK_FILTER` in `backend/app/data/sources.py`): OSMnx's default walk filter plus `highway=steps` excluded and `foot=private` excluded. Missing accessibility tags (surface, incline, wheelchair) stay unknown; they are kept on segments but not used for routing.
* Seating: `amenity=bench` (a bench tagged `bench:type=stand_up` is treated as a leaning bar), `highway=bus_stop` with `bench=yes`, `amenity=shelter` with `bench=yes`. A stop or shelter without a `bench` tag is imported for display as "seating not recorded" and is **not** used for routing.

## NYC DOT Seating Locations (NYC Open Data `esmy-s8q5`)

* Linked from the NYC DOT seating page (https://www.nyc.gov/html/dot/html/pedestrians/seating.shtml) as "Find a bench or leaning bar via NYC Open Data".
* Dataset page: https://data.cityofnewyork.us/Transportation/Seating-Locations/esmy-s8q5
* API used: `https://data.cityofnewyork.us/resource/esmy-s8q5.json` with `$where=within_box(the_geom, …)`. Dataset metadata (`rowsUpdatedAt`) gives `source_updated_at`.
* For the planner, `scripts/update_nyc_data.py` saves every record (5,702 on 2026-10-26; dataset updated 2026-10-13) to `data/nyc/dot_seating.json.gz`, and each area uses the records inside it. OSM and DOT records for the same bench are merged by the existing de-duplication rules.
* Fields used (checked against the published column list on 2026-10-26): `siteid`, `asset_subtype`, `latitude`, `longitude`, `nearest_add`, `on_street`, `side_of_st`, `installation_date`. CSV exports use display names (`SiteID`, `Asset_Subtype`, …); the adapter accepts both.
* `Asset_Subtype` mapping: `BACKED …` → bench with backrest; `BACKLESS …` → bench without; `WORLDS FAIR`, `UNKNOWN BENCH` → bench, backrest unknown; `LEANING BAR` → leaning bar (not counted by default); empty → type not recorded (not counted by default, because it could be a leaning bar). At retrieval time the column summary showed about 880 of 5,702 rows with an empty subtype.
* Terms: NYC Open Data terms of use (https://opendata.cityofnewyork.us/overview/#termsofuse).

## Eligibility rules (`seat-rules-v1`, `backend/app/data/seats.py`)

A seat is used for routing only if all of these hold:

1. It is a seated type (bench, bus stop bench, shelter bench).
2. It is not recorded as private or customers-only.
3. It has no opening hours (or `24/7`), since we cannot know if it is open.
4. A field check has not reported it missing or unusable.
5. It attaches to a walkway within 20 m, without ambiguity.

The rules hash is part of every cache key and of the dataset manifest. Changing rules requires re-running the import.

## Duplicates

Two records merge only if they are within 5 m, have compatible types, attach to the same walkway segment, and are on the same side of it. Seats on opposite sides of a road are never merged even if close. NYC DOT records are kept as the primary when merging with OSM. Each merge is listed in the manifest (`merge_notes`).

## Verification states

* `on_record`: imported from a source, not checked in person (default). Import time is not verification time.
* `field_checked`: a real observation in `data/field_checks.csv` saw it present. It still may be occupied.
* `unavailable`: a field check found it missing or unusable; not used.
* Excluded by you: removed for the current trip only.

## Map tiles

The default basemap is the OpenStreetMap standard tile server, used with visible attribution and normal browser caching, no prefetching or bulk download, in line with https://operations.osmfoundation.org/policies/tiles/. Set `VITE_TILE_URL` to use another provider. The synthetic demo draws its own streets and needs no basemap. The basemap does not work offline.

## Code dependencies

Python: FastAPI (MIT), Pydantic (MIT), NetworkX (BSD), OSMnx (MIT), Shapely (BSD), GeoPandas (BSD), pyproj (MIT). JavaScript: React (MIT), Leaflet (BSD-2), React Leaflet (Hippocratic License 2.1), Vite (MIT), Atkinson Hyperlegible font (SIL Open Font License). Check each package's license file before redistributing.
