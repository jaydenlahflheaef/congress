"""Explicit New York City place search via a replaceable Photon provider.

No keystroke requests. Bounded memory cache and a single rate-limited connection.
Results are limited to the NYC box at the provider and then to the city outline.
"""
import os
import threading
import time
from collections import OrderedDict

import requests

from .nearby import USER_AGENT
from .nyc import nearest_walkway, nyc_region

# Search results are often the middle of a building or park. The router only
# attaches points within 60 m of a walkway, and counts that gap as walking, so
# a result farther than this is moved to the closest walkway instead.
MOVE_TO_WALKWAY_M = 40
WALKWAY_SEARCH_M = 250

_lock = threading.Lock()
_cache = OrderedDict()
_last_request = 0.0


def search_places(q):
    global _last_request
    key = q.strip().casefold()
    if len(key) < 3:
        return []
    region = nyc_region()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        time.sleep(max(0, 1 - (time.monotonic() - _last_request)))
        _last_request = time.monotonic()
        response = requests.get(os.environ.get('REST_ROUTE_GEOCODER_URL', 'https://photon.komoot.io/api/'),
                                params={'q': q.strip(), 'limit': 8, 'bbox': ','.join(f'{v:.4f}' for v in region.bbox)},
                                headers={'User-Agent': USER_AGENT}, timeout=12)
        response.raise_for_status()
        places = []
        for f in response.json().get('features', []):
            p = f.get('properties', {})
            lon, lat = f['geometry']['coordinates'][:2]
            if not region.covers(lat, lon):
                continue
            street = ' '.join(str(p[k]) for k in ['housenumber', 'street'] if p.get(k))
            # In NYC Photon gives the neighborhood as city and the borough as district.
            parts = [p.get('name'), street, p.get('city'), p.get('district')]
            name = ', '.join(dict.fromkeys(str(v) for v in parts if v))
            if name:
                places.append({'id': f"{p.get('osm_type')}-{p.get('osm_id')}", 'name': name,
                               'lat': lat, 'lon': lon, 'category': p.get('osm_value'), 'source': 'osm'})
        places = places[:5]
        for place in places:
            near = nearest_walkway(place['lat'], place['lon'], WALKWAY_SEARCH_M)
            if near and near[2] > MOVE_TO_WALKWAY_M:
                place['lat'], place['lon'] = round(near[0], 7), round(near[1], 7)
                place['moved_to_walkway_m'] = round(near[2])
        _cache[key] = places
        while len(_cache) > 256:
            _cache.popitem(last=False)
        return places
