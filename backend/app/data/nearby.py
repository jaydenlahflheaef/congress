"""Build a small real walking area around a trip, outside the route request.

Areas are cut from the committed NYC OpenStreetMap tiles and NYC DOT snapshot
(see nyc.py), so building one needs no network. One worker builds areas; they
are reused across slider changes and server restarts. Prepared areas (the
Flushing seed) answer instantly. No endpoint names are persisted.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from pyproj import Geod, Transformer
from shapely.geometry import Point, Polygon, box
from shapely.ops import transform
from shapely.prepared import prep

from .build import attach_seats, graph_fingerprint, graph_from_json, graph_to_json, now_iso, seat_distance_matrix
from .dataset import Dataset, DataUnavailable, REPO_ROOT
from .nyc import SEEDS_DIR, dot_seats_within, osm_area, osm_meta
from .seats import SeatRecord, rules_hash

MAX_TRIP_M = 3000
MAX_SEATS = 600
MAX_NODES = 40000
CACHE_TTL = 7 * 86400
CACHE_VERSION = 'nearby-v3'
KEY_PATTERN = re.compile(r'[0-9a-f]{24}')
NOT_LOADED = 'This walking area is no longer loaded. Press Find my walk again.'
USER_AGENT = 'EzWay/0.2 (walking and recorded seating research project)'


def area_for(origin, destination):
    """Round the public map envelope outward; calculate all distances in meters."""
    a, b = (origin.lon, origin.lat), (destination.lon, destination.lat)
    if abs(a[1]) > 85 or abs(b[1]) > 85 or abs(a[0] - b[0]) > 180:
        raise ValueError('This map currently supports trips between 85° south and 85° north that do not cross the date line.')
    if Geod(ellps='WGS84').inv(*a, *b)[2] > MAX_TRIP_M:
        raise ValueError('Choose a shorter walk: the start and destination can be up to 3 km (about 1.9 miles) apart.')
    step = .002
    ring = box(math.floor(min(a[0], b[0]) / step) * step - step,
               math.floor(min(a[1], b[1]) / step) * step - step,
               math.ceil(max(a[0], b[0]) / step) * step + step,
               math.ceil(max(a[1], b[1]) / step) * step + step)
    if ring.bounds[0] <= -180 or ring.bounds[2] >= 180:
        raise ValueError('Trips at the date line are not supported yet.')
    # The tile version is part of the key, so refreshed map data never reuses old areas.
    key = hashlib.sha256(f'{CACHE_VERSION}:{rules_hash()}:{osm_meta().get("version")}:{ring.wkt}'.encode()).hexdigest()[:24]
    return key, ring


def dataset_from_payload(payload):
    graph = graph_from_json(payload['graph'])
    if payload['rules_hash'] != rules_hash() or graph_fingerprint(graph) != payload['fingerprint']:
        raise DataUnavailable('Cached area needs to be refreshed.')
    proj = Transformer.from_crs('EPSG:4326', graph.crs, always_xy=True).transform
    to_ll = Transformer.from_crs(graph.crs, 'EPSG:4326', always_xy=True).transform
    return Dataset(
        mode='nearby', version=payload['version'], area_name=payload.get('area_name', 'Your walking area'), graph=graph,
        seats={s['id']: SeatRecord(**s) for s in payload['seats']}, seat_node=payload['seat_node'],
        matrix=payload['matrix'], places=[], trips=payload.get('trips', []),
        service_polygon_xy=transform(proj, Polygon(payload['service'])),
        service_polygon_lonlat=payload['service'], routing_polygon_lonlat=payload['routing'],
        manifest=payload['manifest'], rules_hash=rules_hash(), basemap_default=True, to_lonlat=to_ll,
    )


def build_area(service, progress):
    center = service.centroid
    crs = f'+proj=aeqd +lat_0={center.y} +lon_0={center.x} +datum=WGS84 +units=m +no_defs'
    proj = Transformer.from_crs('EPSG:4326', crs, always_xy=True).transform
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True).transform
    routing = transform(to_ll, transform(proj, service).buffer(500, join_style='mitre'))
    progress('Loading walking paths around your trip…')
    graph, seats = osm_area(routing, crs)
    if not graph.segments:
        raise DataUnavailable('No mapped walking paths were found here. Try a different start or destination.')
    if len(graph.nodes) > MAX_NODES:
        raise DataUnavailable('This area has too many walking paths for this version. Try a shorter trip.')
    progress('Looking for recorded benches…')
    meta = osm_meta()
    osm_count = len(seats)
    dot_seats, dot_source = dot_seats_within(routing, now_iso())
    for s in dot_seats:
        s.x, s.y = proj(s.lon, s.lat)
    seats += dot_seats
    # Dense areas are thinned to at most MAX_SEATS well-spread benches (never silently:
    # the count, spacing and a warning go into the manifest and the page shows a note).
    built = attach_seats(graph, seats, max_seats=MAX_SEATS)
    progress('Connecting benches to the walking map…')
    # Fingerprint the serialized representation, also used after a restart.
    gj = graph_to_json(graph)
    graph = graph_from_json(gj)
    fingerprint = graph_fingerprint(graph)
    matrix = seat_distance_matrix(graph, built.seat_node)
    retrieved = {'osm': meta.get('extract_date')}
    sources = [{'name': 'OpenStreetMap paths and seating', 'url': 'https://www.openstreetmap.org/copyright', 'license': 'ODbL 1.0',
                'how': meta.get('source')}]
    if dot_source:
        retrieved['nyc_dot_seating'] = dot_seats[0].imported_at
        sources.append(dot_source)
    return {
        'version': f'osm-{(meta.get("extract_date") or "")[:10]}-{fingerprint[:10]}', 'rules_hash': rules_hash(),
        'fingerprint': fingerprint, 'graph': gj, 'matrix': matrix,
        'seats': [asdict(s) for s in built.seats.values()], 'seat_node': built.seat_node,
        'service': list(service.exterior.coords), 'routing': list(routing.exterior.coords),
        'manifest': {'retrieved': retrieved,
                     'counts': {'osm_seat_records': osm_count, 'nyc_dot_seat_records': len(dot_seats),
                                'eligible_seats': len(built.seat_node), 'excluded_seats': len(built.seats) - len(built.seat_node),
                                **({'thinned_seats': built.thinned['dropped'], 'thin_spacing_m': built.thinned['min_spacing_m']}
                                   if built.thinned else {})},
                     'warnings': built.warnings, 'merge_notes': built.merge_notes, 'sources': sources},
    }


def load_seeds(seeds_dir=SEEDS_DIR):
    """Prepared areas committed with the code, keyed by their file name."""
    from ..routing.planner import Planner
    seeds = {}
    for path in sorted(Path(seeds_dir).glob('*.json.gz')):
        try:
            seeds[path.name.removesuffix('.json.gz')] = Planner(dataset_from_payload(json.loads(gzip.decompress(path.read_bytes()))))
        except (OSError, ValueError, KeyError, DataUnavailable):
            continue  # an outdated seed falls back to building the area on demand
    return seeds


class NearbyAreas:
    def __init__(self, cache_dir=None, loader=build_area, region=None, fixed=None):
        self.cache_dir = Path(cache_dir or os.environ.get('REST_ROUTE_AREA_CACHE', REPO_ROOT / 'data' / 'areas'))
        self.loader = loader
        self.region = region
        # Prepared areas answer instantly when both trip ends fall inside their outline.
        self.fixed = dict(fixed or {})
        self._fixed_outlines = {k: prep(Polygon(p.ds.service_polygon_lonlat)) for k, p in self.fixed.items()}
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='rest-route-area')
        self.jobs = OrderedDict()
        self.planners = OrderedDict()
        self.expires = {}

    def prepare(self, origin, destination):
        if self.region and not (self.region.covers(origin.lat, origin.lon) and self.region.covers(destination.lat, destination.lon)):
            raise ValueError(self.region.outside_message)
        key, polygon = area_for(origin, destination)
        for name, outline in self._fixed_outlines.items():
            if outline.covers(Point(origin.lon, origin.lat)) and outline.covers(Point(destination.lon, destination.lat)):
                return self._ready(name, self.fixed[name])
        planner = self.get_planner(key)
        if planner:
            return self._ready(key, planner)
        with self.lock:
            if key in self.jobs and self.jobs[key]['status'] == 'loading':
                return dict(self.jobs[key])
            if sum(j['status'] == 'loading' for j in self.jobs.values()) >= 2:
                return {'status': 'busy', 'message': 'Another walking area is loading. Please try again shortly.'}
            self.jobs[key] = {'status': 'loading', 'dataset_id': key, 'message': 'Getting your walking area ready…'}
            # Bound completed/error status history as well as datasets.
            while len(self.jobs) > 20:
                old = next((k for k, j in self.jobs.items() if j['status'] != 'loading'), None)
                if old is None:
                    break
                del self.jobs[old]
            self.worker.submit(self._build, key, polygon)
            return dict(self.jobs[key])

    def _ready(self, key, planner):
        from .transit_and_restrooms import restrooms_within_polygon
        ds = planner.ds
        return {
            'status': 'ready',
            'dataset_id': key,
            'message': 'Walking area ready.',
            'config': ds.public_config(),
            'seats': [
                s.to_public()
                for s in ds.seats.values()
                if s.routing_eligible or s.type in ('leaning_bar', 'shelter_unknown_seating')
            ],
            'restrooms': restrooms_within_polygon(Polygon(ds.routing_polygon_lonlat), mode='nearby'),
        }

    def status(self, key):
        planner = self.get_planner(key)
        if planner:
            return self._ready(key, planner)
        with self.lock:
            return dict(self.jobs.get(key, {'status': 'error', 'message': NOT_LOADED}))

    def get_planner(self, key):
        if key in self.fixed:
            return self.fixed[key]
        with self.lock:
            if key in self.expires and self.expires[key] <= time.time():
                self.planners.pop(key, None)
                self.expires.pop(key, None)
                self.jobs.pop(key, None)
                (self.cache_dir / f'{key}.json.gz').unlink(missing_ok=True)
                return None
            planner = self.planners.get(key)
            if planner:
                self.planners.move_to_end(key)
                return planner
        return self._reload(key)

    def _reload(self, key):
        """Bring back an area that was dropped from memory but is still saved on disk."""
        from ..routing.planner import Planner
        if not key or not KEY_PATTERN.fullmatch(key):
            return None
        path = self.cache_dir / f'{key}.json.gz'
        try:
            if time.time() - path.stat().st_mtime >= CACHE_TTL:
                return None
            planner = Planner(dataset_from_payload(json.loads(gzip.decompress(path.read_bytes()))))
        except (OSError, ValueError, KeyError, DataUnavailable):
            return None
        self._remember(key, planner, path)
        return planner

    def _remember(self, key, planner, path):
        with self.lock:
            self.planners[key] = planner
            self.planners.move_to_end(key)
            self.expires[key] = (path.stat().st_mtime if path.exists() else time.time()) + CACHE_TTL
            while len(self.planners) > 4:
                evicted, _ = self.planners.popitem(last=False)
                self.expires.pop(evicted, None)
                self.jobs.pop(evicted, None)
            self.jobs[key] = {'status': 'ready', 'dataset_id': key}

    def _build(self, key, polygon):
        from ..routing.planner import Planner
        path = self.cache_dir / f'{key}.json.gz'
        try:
            payload = None
            if path.exists() and time.time() - path.stat().st_mtime < CACHE_TTL:
                try:
                    payload = json.loads(gzip.decompress(path.read_bytes()))
                    dataset_from_payload(payload)
                except (OSError, ValueError, KeyError, DataUnavailable):
                    payload = None
            if payload is None:
                def progress(message):
                    with self.lock:
                        self.jobs[key]['message'] = message
                payload = self.loader(polygon, progress)
                ds = dataset_from_payload(payload)
                # Cache failure should not discard an otherwise usable area.
                try:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    temp = path.with_suffix('.tmp')
                    temp.write_bytes(gzip.compress(json.dumps(payload).encode()))
                    temp.replace(path)
                    files = sorted(self.cache_dir.glob('*.json.gz'), key=lambda p: p.stat().st_mtime, reverse=True)
                    for old in files[12:]:
                        old.unlink(missing_ok=True)
                except OSError:
                    ds.manifest.setdefault('warnings', []).append('Area cache could not be saved; it will reload after a restart.')
            else:
                ds = dataset_from_payload(payload)
            self._remember(key, Planner(ds), path)
        except Exception as exc:
            message = str(exc) if isinstance(exc, DataUnavailable) else 'We could not load walking paths and benches here. Try again, or choose another location.'
            with self.lock:
                self.jobs[key] = {'status': 'error', 'dataset_id': key, 'message': message}
