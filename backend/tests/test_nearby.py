"""Area lifecycle, real OSM adapter boundaries, and worldwide search tests.

All network inputs here are simulated; live smoke checks are documented separately.
"""
import threading
import time
from dataclasses import asdict
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.data import geocoder, nearby
from app.data.build import graph_fingerprint, graph_from_json, graph_to_json
from app.data.dataset import load_synthetic
from app.data.nearby import NearbyAreas, area_for, dataset_from_payload, download_area
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
        monkeypatch.setattr('app.main.search_world',Mock(side_effect=RuntimeError('upstream failed')))
        assert c.get('/api/search?q=Boston').status_code == 503
        assert c.get('/api/search?q=a').status_code == 422


def test_geocoder_normalizes_and_caches(monkeypatch):
    geocoder._cache.clear()
    geocoder._last_request = 0
    response = Mock()
    response.json.return_value = {'features':[{'geometry':{'coordinates':[-71,42]},'properties':{
        'osm_type':'N','osm_id':123,'name':'Library','city':'Boston','country':'United States'}}]}
    request = Mock(return_value=response)
    monkeypatch.setattr(geocoder.requests,'get',request)
    assert geocoder.search_world('Library Boston')[0]['name'] == 'Library, Boston, United States'
    assert geocoder.search_world(' library boston ')[0]['lon'] == -71
    assert request.call_count == 1
    assert geocoder.search_world('x') == []


def test_loader_projects_southern_hemisphere_and_preserves_osm_seats(monkeypatch):
    import networkx as nx
    import geopandas as gpd
    import osmnx as ox
    from shapely.geometry import Point
    G = nx.MultiDiGraph(crs='EPSG:4326')
    G.add_node(1,x=151.2,y=-33.87)
    G.add_node(2,x=151.201,y=-33.87)
    for a,b in [(1,2),(2,1)]:
        G.add_edge(a,b,key=0,osmid=44,highway='footway',length=100)
    feats = gpd.GeoDataFrame({'amenity':['bench'],'access':['yes'],'geometry':[Point(151.2,-33.87)]},
                            index=__import__('pandas').MultiIndex.from_tuples([('node',1)]),crs='EPSG:4326')
    monkeypatch.setattr(ox,'graph_from_polygon',lambda *a,**k:G)
    monkeypatch.setattr(ox,'features_from_polygon',lambda *a,**k:feats)
    progress = []
    p = download_area(Polygon([(151.199,-33.871),(151.202,-33.871),(151.202,-33.869),(151.199,-33.869)]),progress.append)
    ds = dataset_from_payload(p)
    assert ds.mode == 'nearby' and len(ds.seat_node) == 1
    assert ds.seats['osm-node-1'].source_refs[0]['source'] == 'osm'
    paths = [s.length_m for s in ds.graph.segments.values() if s.kind=='path']
    assert 90 < sum(paths) < 100
    assert len(progress) == 3


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
