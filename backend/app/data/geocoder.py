"""Explicit worldwide place search via a replaceable Photon provider.

No keystroke requests. Bounded memory cache and a single rate-limited connection.
"""
import os
import threading
import time
from collections import OrderedDict

import requests

from .nearby import USER_AGENT

_lock = threading.Lock()
_cache = OrderedDict()
_last_request = 0.0


def search_world(q):
    global _last_request
    key = q.strip().casefold()
    if len(key) < 3:
        return []
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        time.sleep(max(0, 1 - (time.monotonic() - _last_request)))
        _last_request = time.monotonic()
        response = requests.get(os.environ.get('REST_ROUTE_GEOCODER_URL', 'https://photon.komoot.io/api/'),
                                params={'q': q.strip(), 'limit': 5}, headers={'User-Agent': USER_AGENT}, timeout=12)
        response.raise_for_status()
        places = []
        for f in response.json().get('features', []):
            p = f.get('properties', {})
            lon, lat = f['geometry']['coordinates'][:2]
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                continue
            street = ' '.join(str(p[k]) for k in ['housenumber', 'street'] if p.get(k))
            parts = [p.get('name'), street, p.get('city') or p.get('county'), p.get('state'), p.get('country')]
            name = ', '.join(dict.fromkeys(str(v) for v in parts if v))
            if name:
                places.append({'id': f"{p.get('osm_type')}-{p.get('osm_id')}", 'name': name,
                               'lat': lat, 'lon': lon, 'category': p.get('osm_value'), 'source': 'osm'})
        _cache[key] = places
        while len(_cache) > 256:
            _cache.popitem(last=False)
        return places
