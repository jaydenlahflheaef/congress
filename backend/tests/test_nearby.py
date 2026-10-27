"""Area lifecycle, NYC tile loading, prepared areas and NYC search tests.

All network inputs here are simulated; live smoke checks are documented separately.
"""
import threading
import time
from dataclasses import asdict
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.data import geocoder, nearby, nyc
from app.data.build import graph_fingerprint, graph_from_json, graph_to_json
from app.data.dataset import load_synthetic
from app.data.nearby import NOT_LOADED, NearbyAreas, area_for, build_area, dataset_from_payload
from app.main import create_app
from app.models.schemas import LatLon


def payload():
    ds = load_synthetic()
    graph = graph_to_json(ds.graph)
    return dict(version='offline-area-test', rules_hash=ds.rules_hash, fingerprint=graph_fingerprint(graph_from_json(graph)),
                graph=graph, seats=[asdict(s) for s in ds.seats.values()], seat_node=ds.seat_node, matrix=ds.matrix,
                service=ds.service_polygon_lonlat, routing=ds.routing_polygon_lonlat, manifest=ds.manifest)


def wait_ready(manager, key):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = manager.status(key)
        if state['status'] != 'loading':
            return state
        time.sleep(.01)
    pytest.fail('Area worker did not finish')


@pytest.mark.parametrize('lat,lon', [(42.35,-71.07), (51.5,-.13), (-33.87,151.2), (35.68,139.76)])
def test_area_is_local_anywhere(lat, lon):
    a = LatLon(lat=lat,lon=lon)
    b = LatLon(lat=lat+.001,lon=lon+.001)
    key, polygon = area_for(a,b)
    assert len(key) == 24
    from shapely.geometry import Point
    assert polygon.contains(Point(a.lon,a.lat)) and polygon.contains(Point(b.lon,b.lat))
    assert area_for(b,a)[0] == key


def test_large_and_date_line_trips_rejected():
    with pytest.raises(ValueError, match='shorter walk'):
        area_for(LatLon(lat=40,lon=-73),LatLon(lat=41,lon=-73))
    with pytest.raises(ValueError, match='date line'):
        area_for(LatLon(lat=0,lon=179.999),LatLon(lat=0,lon=-179.999))


def test_one_load_per_area_and_persistent_cache(tmp_path):
    data = payload()
    load = Mock(return_value=data)
    m = NearbyAreas(tmp_path, load)
    a, b = LatLon(lat=42.35,lon=-71.07),LatLon(lat=42.351,lon=-71.071)
    try:
        first = m.prepare(a,b)
        assert first['status'] == 'loading'
        key = first['dataset_id']
        ready = wait_ready(m,key)
        assert ready['status'] == 'ready'
        assert ready['config']['mode'] == 'nearby'
        assert m.prepare(a,b)['status'] == 'ready'
        assert load.call_count == 1
        assert m.get_planner(key) is not None
        second = NearbyAreas(tmp_path, Mock(side_effect=AssertionError('cache not used')))
        try:
            again = second.prepare(a,b)
            assert wait_ready(second,again['dataset_id'])['status'] == 'ready'
        finally:
            second.worker.shutdown()
    finally:
        m.worker.shutdown()


def test_failure_is_not_fake_seating_and_can_retry(tmp_path):
    m = NearbyAreas(tmp_path, Mock(side_effect=[RuntimeError('private provider detail'), payload()]))
    a = LatLon(lat=42.35,lon=-71.07)
    try:
        key = m.prepare(a,a)['dataset_id']
        failed = wait_ready(m,key)
        assert failed['status'] == 'error' and 'private provider detail' not in failed['message']
        assert 'seats' not in failed and m.get_planner(key) is None
        m.prepare(a,a)
        assert wait_ready(m,key)['status'] == 'ready'
    finally:
        m.worker.shutdown()


def test_queue_is_bounded_and_duplicate_requests_share_job(tmp_path):
    gate = threading.Event()
    def load(*_):
        gate.wait(5)
        return payload()
    m = NearbyAreas(tmp_path, load)
    a,b,c = (LatLon(lat=lat,lon=0) for lat in [10,20,30])
    try:
        first = m.prepare(a,a)
        assert m.prepare(a,a)['dataset_id'] == first['dataset_id']
        assert m.prepare(b,b)['status'] == 'loading'
        assert m.prepare(c,c)['status'] == 'busy'
    finally:
        gate.set(); m.worker.shutdown()


def test_api_requires_area_and_returns_clear_failures(tmp_path, monkeypatch):
    app = create_app(tmp_path,serve_frontend=False)
    with TestClient(app) as c:
        req = dict(origin={'lat':42,'lon':-71}, destination={'lat':42.001,'lon':-71},max_gap_m=150)
        r = c.post('/api/route',json=req).json()
        assert r['data_mode'] == 'nearby' and r['status'] == 'data_unavailable'
        assert r['route_geojson'] is None
        assert c.post('/api/areas',json={**req,'destination':{'lat':43,'lon':-71}}).status_code == 422
        assert c.post('/api/areas',json={'origin':{'lat':100,'lon':0},'destination':req['destination']}).status_code == 422
        assert c.get('/api/areas/unknown').json()['status'] == 'error'
        monkeypatch.setattr('app.main.search_places',Mock(side_effect=RuntimeError('upstream failed')))
        assert c.get('/api/search?q=Boston').status_code == 503
        assert c.get('/api/search?q=a').status_code == 422


def test_expired_memory_area_is_reloaded(tmp_path):
    m = NearbyAreas(tmp_path, Mock(return_value=payload()))
    a = LatLon(lat=42.35,lon=-71.07)
    try:
        key = m.prepare(a,a)['dataset_id']
        assert wait_ready(m,key)['status'] == 'ready'
        m.expires[key] = time.time() - 1
        assert m.get_planner(key) is None
        assert m.status(key)['status'] == 'error'
        assert m.prepare(a,a)['status'] == 'loading'
        assert wait_ready(m,key)['status'] == 'ready'
    finally:
        m.worker.shutdown()


@pytest.fixture
def nyc_tiles(tmp_path, monkeypatch):
    """A synthetic Midtown tile: an 8 x 8 walkway grid, a 2-node scrap, one bench and one DOT seat."""
    osm = tmp_path / 'osm'
    osm.mkdir()
    lon0, lat0, step = -73.996, 40.745, .0005
    nid = lambda i, j: 1000 + i * 8 + j
    segments = []
    for i in range(8):
        for j in range(8):
            for di, dj in ((1, 0), (0, 1)):
                if i + di < 8 and j + dj < 8:
                    a, b = nid(i, j), nid(i + di, j + dj)
                    flat = [round(v * 1e6) for v in (lon0 + j * step, lat0 + i * step, lon0 + (j + dj) * step, lat0 + (i + di) * step)]
                    segments.append([f'e:w{a}{b}.0', a, b, a, 3, {'highway': 'footway'}, flat])
    scrap = [round(v * 1e6) for v in (lon0 + .0002, lat0 + .0041, lon0 + .0004, lat0 + .0041)]
    segments.append(['e:w9.0', 9001, 9002, 9, 3, {'highway': 'footway'}, scrap])
    seats = [['node', 77, lon0 + .0010, lat0 + .00002, 'Point', {'amenity': 'bench', 'backrest': 'yes'}]]
    tile = nyc.tile_of(lon0, lat0)
    (osm / f'{tile[0]}_{tile[1]}.json.gz').write_bytes(__import__('gzip').compress(__import__('json').dumps({'segments': segments, 'seats': seats}).encode()))
    (osm / 'meta.json').write_text('{"version": "osm-test", "extract_date": "2026-10-24T00:00:00Z", "source": "test tiles"}')
    dot = {'retrieved': '2026-10-26T00:00:00Z', 'source_updated': '2026-10-13T00:00:00Z', 'rows': [
        {'siteid': 'SEAT.1', 'asset_subtype': 'BACKED 2.0', 'latitude': str(lat0 + .00198), 'longitude': str(lon0 + .0020), 'nearest_add': '1 Test Pl'},
        {'siteid': 'SEAT.2', 'asset_subtype': 'BACKED 2.0', 'latitude': '40.80', 'longitude': '-73.90'}]}
    monkeypatch.setattr(nyc, 'OSM_DIR', osm)
    monkeypatch.setattr(nyc, 'dot_snapshot', lambda: dot)
    nyc.osm_meta.cache_clear()
    yield Polygon([(lon0, lat0), (lon0 + .0035, lat0), (lon0 + .0035, lat0 + .0035), (lon0, lat0 + .0035)])
    nyc.osm_meta.cache_clear()


def test_area_is_built_from_tiles_with_osm_and_dot_seats(nyc_tiles):
    progress = []
    ds = dataset_from_payload(build_area(nyc_tiles, progress.append))
    assert ds.mode == 'nearby' and len(progress) == 3
    assert sorted(ds.seat_node) == ['dot-SEAT.1', 'osm-node-77']
    assert ds.seats['osm-node-77'].backrest is True
    assert ds.seats['dot-SEAT.1'].source_refs[0]['source'] == 'nyc_dot_seating'
    paths = [s for s in ds.graph.segments.values() if s.kind == 'path']
    assert not any(s.tags['osmid'] == '9' for s in paths), 'isolated scraps are dropped'
    # 112 grid edges of about 42 m (east-west) and 56 m (north-south), split where seats attach
    assert 5300 < sum(s.length_m for s in paths) < 5500
    assert ds.manifest['retrieved'] == {'osm': '2026-10-24T00:00:00Z', 'nyc_dot_seating': '2026-10-26T00:00:00Z'}
    assert ds.manifest['counts']['nyc_dot_seat_records'] == 1


def test_area_without_walkways_is_reported_not_faked(nyc_tiles):
    with pytest.raises(nearby.DataUnavailable, match='No mapped walking paths'):
        build_area(Polygon([(-73.80, 40.60), (-73.799, 40.60), (-73.799, 40.601), (-73.80, 40.601)]), lambda m: None)


def test_walkway_filter_matches_overpass_rules_and_skips_indoor():
    from app.data.sources import foot_directions, is_walkable_way
    assert is_walkable_way({'highway': 'footway', 'footway': 'sidewalk'})
    assert is_walkable_way({'highway': 'footway', 'indoor': 'no'})
    for tags in ({'highway': 'steps'}, {'highway': 'motorway'}, {'highway': 'footway', 'access': 'private'},
                 {'highway': 'footway', 'foot': 'no'}, {'highway': 'pedestrian', 'area': 'yes'},
                 {'highway': 'footway', 'indoor': 'yes'}, {'highway': 'footway', 'level': '-1'}, {'building': 'yes'}):
        assert not is_walkable_way(tags), tags
    assert foot_directions({'oneway:foot': 'yes'}) == (True, False)
    assert foot_directions({'oneway:foot': '-1'}) == (False, True)
    assert foot_directions({'oneway': 'yes'}) == (True, True)


def test_evicted_area_reloads_from_disk_and_bad_ids_are_ignored(tmp_path):
    m = NearbyAreas(tmp_path, Mock(return_value=payload()))
    points = [LatLon(lat=40.70 + i * .01, lon=-73.95) for i in range(5)]
    try:
        keys = [wait_ready(m, m.prepare(p, p)['dataset_id'])['dataset_id'] for p in points]
        assert keys[0] not in m.planners, 'only four areas stay in memory'
        assert m.get_planner(keys[0]) is not None
        assert m.status(keys[0])['status'] == 'ready'
        assert m.get_planner('../../etc/passwd') is None and m.get_planner(None) is None
        assert m.status('nope') == {'status': 'error', 'message': NOT_LOADED}
    finally:
        m.worker.shutdown()


def test_app_is_nyc_only_and_flushing_opens_instantly(tmp_path, monkeypatch):
    with TestClient(create_app(tmp_path, serve_frontend=False)) as c:
        cfg = c.get('/api/config').json()['modes']['nearby']
        assert cfg['area_name'] == 'New York City' and len(cfg['region_bounds']) == 4
        trip = cfg['trips'][0]
        area = c.post('/api/areas', json={'origin': trip['from'], 'destination': trip['to']}).json()
        assert area['status'] == 'ready' and area['dataset_id'] == 'flushing'
        assert area['config']['area_name'] == 'Downtown Flushing'
        sources = {s['source_refs'][0]['source'] for s in area['seats']}
        assert sources == {'osm', 'nyc_dot_seating'}
        r = c.post('/api/route', json={'origin': trip['from'], 'destination': trip['to'], 'max_gap_m': 400,
                                       'dataset_mode': 'nearby', 'dataset_id': 'flushing'}).json()
        assert r['status'] == 'ok' and r['legs']
        hoboken = c.post('/api/areas', json={'origin': {'lat': 40.744, 'lon': -74.0324}, 'destination': {'lat': 40.745, 'lon': -74.031}})
        assert hoboken.status_code == 422 and 'New York City' in hoboken.json()['detail']


def test_search_is_limited_to_nyc_and_moves_building_centers_to_walkways(monkeypatch):
    geocoder._cache.clear()
    geocoder._last_request = 0
    response = Mock()
    response.json.return_value = {'features': [
        {'geometry': {'coordinates': [-73.8289, 40.7578]}, 'properties': {
            'osm_type': 'W', 'osm_id': 1, 'name': 'Library', 'housenumber': '41-17', 'street': 'Main Street',
            'city': 'Flushing', 'district': 'Queens', 'state': 'NY', 'country': 'United States'}},
        {'geometry': {'coordinates': [-71.06, 42.36]}, 'properties': {'osm_type': 'N', 'osm_id': 2, 'name': 'Boston Library'}},
    ]}
    request = Mock(return_value=response)
    monkeypatch.setattr(geocoder.requests, 'get', request)
    monkeypatch.setattr(geocoder, 'nearest_walkway', lambda lat, lon, max_m: (lat + .0005, lon, 55.0))
    places = geocoder.search_places('Library Flushing')
    assert [p['name'] for p in places] == ['Library, 41-17 Main Street, Flushing, Queens']
    assert places[0]['lat'] == 40.7583 and places[0]['moved_to_walkway_m'] == 55
    assert request.call_args.kwargs['params']['bbox'].startswith('-74.2')
    assert geocoder.search_places(' library flushing ')[0]['lon'] == -73.8289
    assert request.call_count == 1
    assert geocoder.search_places('x') == []


def _bench(i, x, y, **kw):
    from app.data.seats import SeatRecord
    return SeatRecord(id=f'b{i}', lon=0, lat=0, x=x, y=y, type=kw.pop('type', 'bench'), public_access='yes', **kw)


def test_thinning_keeps_everything_when_under_the_limit():
    from app.data.build import thin_seats
    seats = [_bench(i, i * 3, 0) for i in range(10)]
    kept, dropped, spacing = thin_seats(seats, 600)
    assert kept == seats and dropped == [] and spacing is None


def test_thinning_spreads_benches_and_prefers_backrests_and_real_benches():
    from app.data.build import thin_seats
    # 40 benches in a 4 m tight row, plus a few far apart
    seats = [_bench(i, i * 4, 0) for i in range(40)] + [_bench(100 + i, 1000 + i * 500, 0) for i in range(3)]
    seats[5].backrest = True                 # preferred over its neighbors
    seats[6].type = 'bus_stop_bench'         # least preferred
    kept, dropped, spacing = thin_seats(seats, 20)
    assert len(kept) <= 20 and len(kept) + len(dropped) == len(seats)
    assert spacing is not None and spacing >= 10
    ids = {s.id for s in kept}
    assert 'b5' in ids and {'b100', 'b101', 'b102'} <= ids
    xs = sorted(s.x for s in kept)
    assert all(b - a >= spacing - 1e-9 for a, b in zip(xs, xs[1:])), 'kept benches respect the spacing'
    again, _, _ = thin_seats(list(reversed(seats)), 20)
    assert {s.id for s in again} == ids, 'result does not depend on input order'


def test_dense_area_is_thinned_not_rejected_and_reports_it(tmp_path):
    from app.data.build import attach_seats
    ds = load_synthetic()
    seats = []
    for i in range(30):  # many benches along the demo's first walkway
        n = next(iter(ds.graph.segments.values()))
        seats.append(_bench(i, n.xy[0][0] + i * 6, n.xy[0][1] + 1))
    built = attach_seats(ds.graph, seats, max_seats=8)
    assert len(built.seat_node) <= 8
    assert built.thinned and built.thinned['kept'] + built.thinned['dropped'] <= 30
    assert any('Dense area' in w for w in built.warnings)
    skipped = [s for s in built.seats.values() if not s.routing_eligible and 'dense area' in (s.exclusion_reason or '')]
    assert len(skipped) == built.thinned['dropped'], 'skipped benches stay listed, marked as not counted'
