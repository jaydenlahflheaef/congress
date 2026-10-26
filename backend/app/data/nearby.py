"""Load a small real walking area around a trip, outside the route request.

One worker bounds downloads/OSMnx settings changes. Area artifacts are reused
across slider changes and server restarts. No endpoint names are persisted.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from pyproj import Geod, Transformer
from shapely.geometry import Polygon, box
from shapely.ops import transform

from .build import attach_seats, graph_fingerprint, graph_from_json, graph_to_json, now_iso, seat_distance_matrix
from .dataset import Dataset, DataUnavailable, REPO_ROOT
from .seats import SeatRecord, rules_hash
from .sources import WALK_FILTER, osm_feature_to_seat, osmnx_to_pedgraph

MAX_TRIP_M = 3000
MAX_SEATS = 600
MAX_NODES = 20000
CACHE_TTL = 7 * 86400
CACHE_VERSION = 'nearby-v1'
USER_AGENT = 'RestRoute/0.2 (walking and recorded seating research project)'


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
    key = hashlib.sha256(f'{CACHE_VERSION}:{rules_hash()}:{ring.wkt}'.encode()).hexdigest()[:24]
    return key, ring


def dataset_from_payload(payload):
    graph = graph_from_json(payload['graph'])
    if payload['rules_hash'] != rules_hash() or graph_fingerprint(graph) != payload['fingerprint']:
        raise DataUnavailable('Cached area needs to be refreshed.')
    proj = Transformer.from_crs('EPSG:4326', graph.crs, always_xy=True).transform
    to_ll = Transformer.from_crs(graph.crs, 'EPSG:4326', always_xy=True).transform
    return Dataset(
        mode='nearby', version=payload['version'], area_name='Your walking area', graph=graph,
        seats={s['id']: SeatRecord(**s) for s in payload['seats']}, seat_node=payload['seat_node'],
        matrix=payload['matrix'], places=[], trips=[],
        service_polygon_xy=transform(proj, Polygon(payload['service'])),
        service_polygon_lonlat=payload['service'], routing_polygon_lonlat=payload['routing'],
        manifest=payload['manifest'], rules_hash=rules_hash(), basemap_default=True, to_lonlat=to_ll,
    )


def download_area(service, progress):
    import osmnx as ox

    center = service.centroid
    crs = f'+proj=aeqd +lat_0={center.y} +lon_0={center.x} +datum=WGS84 +units=m +no_defs'
    proj = Transformer.from_crs('EPSG:4326', crs, always_xy=True).transform
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True).transform
    routing = transform(to_ll, transform(proj, service).buffer(500, join_style='mitre'))
    if routing.bounds[0] <= -180 or routing.bounds[2] >= 180:
        raise DataUnavailable('The buffered walking area crosses the date line. Choose a different trip.')
    ox.settings.http_user_agent = USER_AGENT
    ox.settings.requests_timeout = 45
    ox.settings.log_console = False
    ox.settings.log_file = False
    # Our final versioned artifact is the cache; avoid an unbounded second cache.
    ox.settings.use_cache = False
    ox.settings.overpass_url = os.environ.get('REST_ROUTE_OVERPASS_URL', 'https://overpass-api.de/api')
    ox.settings.useful_tags_way = list(dict.fromkeys(ox.settings.useful_tags_way + ['foot', 'access', 'oneway:foot', 'footway']))
    progress('Loading walking paths around your trip…')
    raw = ox.graph_from_polygon(routing, network_type='walk', custom_filter=WALK_FILTER + '["access"!~"no|customers|permit"]',
                                simplify=True, retain_all=True, truncate_by_edge=True)
    if len(raw.nodes) > MAX_NODES:
        raise DataUnavailable('This area has too many walking paths for this version. Try a shorter trip.')
    graph, warnings = osmnx_to_pedgraph(ox.project_graph(raw, to_crs=crs), crs)
    progress('Looking for recorded benches…')
    imported = now_iso()
    try:
        features = ox.features_from_polygon(routing, tags={'amenity': ['bench', 'shelter'], 'highway': 'bus_stop'})
    except ox._errors.InsufficientResponseError:
        features = None
    seats = []
    if features is not None:
        for (element, oid), row in features.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            pt = geom if geom.geom_type == 'Point' else geom.representative_point()
            s = osm_feature_to_seat(str(element), oid, row.drop(labels=['geometry']).to_dict(), pt.x, pt.y, geom.geom_type, imported)
            if s:
                s.x, s.y = proj(s.lon, s.lat)
                seats.append(s)
    built = attach_seats(graph, seats)
    if len(built.seat_node) > MAX_SEATS:
        raise DataUnavailable('This area contains more than 600 usable seat records. Try a shorter trip; no seats have been silently removed.')
    progress('Connecting benches to the walking map…')
    # Fingerprint the serialized representation, also used after a restart.
    gj = graph_to_json(graph)
    graph = graph_from_json(gj)
    fingerprint = graph_fingerprint(graph)
    matrix = seat_distance_matrix(graph, built.seat_node)
    return {
        'version': f'osm-{imported[:10]}-{fingerprint[:10]}', 'rules_hash': rules_hash(),
        'fingerprint': fingerprint, 'graph': gj, 'matrix': matrix,
        'seats': [asdict(s) for s in built.seats.values()], 'seat_node': built.seat_node,
        'service': list(service.exterior.coords), 'routing': list(routing.exterior.coords),
        'manifest': {'retrieved': {'osm': imported}, 'counts': {'eligible_seats': len(built.seat_node),
                     'excluded_seats': len(built.seats) - len(built.seat_node)},
                     'warnings': warnings + built.warnings,
                     'sources': [{'name': 'OpenStreetMap paths and seating', 'url': 'https://www.openstreetmap.org/copyright', 'license': 'ODbL 1.0'}]},
    }


class NearbyAreas:
    def __init__(self, cache_dir=None, loader=download_area):
        self.cache_dir = Path(cache_dir or os.environ.get('REST_ROUTE_AREA_CACHE', REPO_ROOT / 'data' / 'areas'))
        self.loader = loader
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='rest-route-area')
        self.jobs = OrderedDict()
        self.planners = OrderedDict()
        self.expires = {}

    def prepare(self, origin, destination):
        key, polygon = area_for(origin, destination)
        with self.lock:
            if self.get_planner(key):
                self.planners.move_to_end(key)
                return self._ready(key)
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

    def _ready(self, key):
        ds = self.planners[key].ds
        return {'status': 'ready', 'dataset_id': key, 'message': 'Walking area ready.', 'config': ds.public_config(),
                'seats': [s.to_public() for s in ds.seats.values() if s.routing_eligible]}

    def status(self, key):
        with self.lock:
            if self.get_planner(key):
                return self._ready(key)
            return dict(self.jobs.get(key, {'status': 'error', 'message': 'This walking area expired. Find your route again.'}))

    def get_planner(self, key):
        with self.lock:
            if key in self.expires and self.expires[key] <= time.time():
                self.planners.pop(key, None)
                self.expires.pop(key, None)
                self.jobs.pop(key, None)
            planner = self.planners.get(key)
            if planner:
                self.planners.move_to_end(key)
            return planner

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
            planner = Planner(ds)
            with self.lock:
                self.planners[key] = planner
                self.expires[key] = (path.stat().st_mtime if path.exists() else time.time()) + CACHE_TTL
                while len(self.planners) > 4:
                    evicted, _ = self.planners.popitem(last=False)
                    self.expires.pop(evicted, None)
                    self.jobs.pop(evicted, None)
                self.jobs[key] = {'status': 'ready', 'dataset_id': key}
        except Exception as exc:
            # Do not expose URLs containing queried bounds or provider internals.
            message = str(exc) if isinstance(exc, DataUnavailable) else 'We could not load walking paths and benches here. Try again, or choose another location.'
            with self.lock:
                self.jobs[key] = {'status': 'error', 'dataset_id': key, 'message': message}
