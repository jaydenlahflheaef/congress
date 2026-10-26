import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchConfig, fetchSeats } from './api/client';
import { useRoutePlanner } from './hooks/useRoutePlanner';
import { LimitControl } from './components/LimitControl';
import { PlaceSearch } from './components/PlaceSearch';
import { ResultCard } from './components/ResultCard';
import { PrintSummary } from './components/PrintSummary';
import { HowItWorks } from './components/HowItWorks';
import RouteMap from './components/RouteMap';
import { MapSummary } from './components/MapSummary';
import type { AppConfig, LatLon, Mode, ModeConfig, NamedPoint, Seat } from './types';

const PREF_KEY = 'restroute.maxGap';
// Used only to center the map when the Flushing pilot has not been imported yet.
const FLUSHING_PLACEHOLDER_BOUNDS: [number, number][] = [
  [-73.836, 40.754],
  [-73.82, 40.754],
  [-73.82, 40.765],
  [-73.836, 40.765],
  [-73.836, 40.754],
];

function readPref(fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(PREF_KEY));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function writePref(v: number) {
  try {
    window.localStorage.setItem(PREF_KEY, String(v));
  } catch {
    /* storage unavailable: preference simply not remembered */
  }
}

function bboxOf(poly: [number, number][]): [number, number, number, number] {
  const lons = poly.map((p) => p[0]);
  const lats = poly.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('synthetic_demo');
  const [origin, setOriginRaw] = useState<NamedPoint | null>(null);
  const [destination, setDestinationRaw] = useState<NamedPoint | null>(null);
  const [maxGap, setMaxGapRaw] = useState<number>(150);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [armed, setArmed] = useState<'from' | 'to' | 'bench' | null>(null);
  const [hypo, setHypo] = useState<LatLon[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [showComparison, setShowComparison] = useState(true);
  const [basemap, setBasemap] = useState(false);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [page, setPage] = useState<'plan' | 'how'>(window.location.hash === '#how' ? 'how' : 'plan');
  const [resultsOpen, setResultsOpen] = useState(true);
  const [tripId, setTripId] = useState('');

  useEffect(() => {
    const ctrl = new AbortController();
    fetchConfig(ctrl.signal)
      .then((c) => {
        setConfig(c);
        setMode(c.default_mode);
        setMaxGapRaw(readPref(c.slider.default_m));
        setBasemap(!!c.modes[c.default_mode].basemap_default);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setConfigError('Could not reach the Rest Route server.');
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const onHash = () => setPage(window.location.hash === '#how' ? 'how' : 'plan');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const modeCfg: ModeConfig | null = config ? config.modes[mode] : null;

  useEffect(() => {
    setSeats([]);
    if (!modeCfg?.available || !modeCfg.routing_polygon) return;
    const ctrl = new AbortController();
    fetchSeats(mode, bboxOf(modeCfg.routing_polygon), ctrl.signal)
      .then((r) => setSeats(r.seats))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [mode, modeCfg]);

  const planner = useRoutePlanner({ mode, origin, destination, maxGap, excluded, hypothetical: hypo }, enabled);
  const { result } = planner;

  const resetTrip = useCallback(() => {
    setExcluded([]);
    setSelectedLeg(null);
  }, []);
  const setOrigin = (p: NamedPoint | null) => {
    setOriginRaw(p);
    resetTrip();
  };
  const setDestination = (p: NamedPoint | null) => {
    setDestinationRaw(p);
    resetTrip();
  };
  const setMaxGap = (v: number) => {
    setMaxGapRaw(v);
    writePref(v);
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setOriginRaw(null);
    setDestinationRaw(null);
    setEnabled(false);
    planner.clear();
    resetTrip();
    setHypo([]);
    setTripId('');
    setBasemap(!!config?.modes[m].basemap_default || !config?.modes[m].available);
  };

  const chooseTrip = (id: string) => {
    setTripId(id);
    const t = modeCfg?.trips?.find((x) => x.id === id);
    if (!t) return;
    setOriginRaw(t.from);
    setDestinationRaw(t.to);
    resetTrip();
    if (t.suggested_limits_m.length) setMaxGap(t.suggested_limits_m[0]);
    setEnabled(true);
  };

  const onPick = (lat: number, lon: number) => {
    if (armed === 'bench') {
      setHypo((h) => (h.length >= 3 ? h : [...h, { lat, lon }]));
      setArmed(null);
      return;
    }
    const p = { name: `Map pin (${lat.toFixed(5)}, ${lon.toFixed(5)})`, lat, lon };
    if (armed === 'from') setOrigin(p);
    if (armed === 'to') setDestination(p);
    setArmed(null);
    setTripId('');
  };

  const useMyLocation = () => {
    setGeoMsg(null);
    if (!('geolocation' in navigator)) {
      setGeoMsg('This browser cannot share a location. Choose the start on the map or from the list.');
      return;
    }
    setGeoMsg('Asking your browser for your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin({ name: 'My location', lat: pos.coords.latitude, lon: pos.coords.longitude });
        setTripId('');
        setGeoMsg(`Location found (accuracy about ${Math.round(pos.coords.accuracy)} m).`);
      },
      () => setGeoMsg('Location not available. Choose the start on the map or from the list.'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const seatsById = useMemo(() => Object.fromEntries(seats.map((s) => [s.id, s])), [seats]);
  const mapConfig: ModeConfig | null = modeCfg
    ? modeCfg.available
      ? modeCfg
      : { ...modeCfg, service_polygon: FLUSHING_PLACEHOLDER_BOUNDS }
    : null;

  if (configError) {
    return (
      <main className="fatal">
        <h1>Rest Route</h1>
        <p role="alert">{configError} Please try again in a moment.</p>
      </main>
    );
  }
  if (!config || !modeCfg || !mapConfig) {
    return <main className="fatal">Loading Rest Route…</main>;
  }

  const go = (p: 'plan' | 'how') => {
    window.location.hash = p === 'how' ? '#how' : '';
    setPage(p);
  };

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ⌁
          </span>
          <span>Rest Route</span>
        </div>
        <nav aria-label="Pages">
          <button type="button" className={`link ${page === 'plan' ? 'active' : ''}`} onClick={() => go('plan')}>
            Planner
          </button>
          <button type="button" className={`link ${page === 'how' ? 'active' : ''}`} onClick={() => go('how')}>
            How it works
          </button>
        </nav>
      </header>

      {page === 'how' ? (
        <main className="how-wrap">
          <HowItWorks onBack={() => go('plan')} limitationNote={config.limitation_note} />
        </main>
      ) : (
        <main className="layout no-print">
          <aside className="panel">
            <div className="mode-switch" role="group" aria-label="Data set">
              <button
                type="button"
                aria-pressed={mode === 'live_pilot'}
                className={mode === 'live_pilot' ? 'on' : ''}
                onClick={() => switchMode('live_pilot')}
              >
                Flushing pilot
              </button>
              <button
                type="button"
                aria-pressed={mode === 'synthetic_demo'}
                className={mode === 'synthetic_demo' ? 'on' : ''}
                onClick={() => switchMode('synthetic_demo')}
              >
                Demo (synthetic)
              </button>
            </div>
            {mode === 'synthetic_demo' ? (
              <p className="notice demo" data-testid="demo-indicator">
                <strong>Demo mode.</strong> Fictional streets and seats for showing how the router works. Not a real
                place.
              </p>
            ) : modeCfg.available ? (
              <p className="notice">
                <strong>{modeCfg.area_name}.</strong> Coverage is the dashed outline on the map. Data version{' '}
                {modeCfg.dataset_version}.
              </p>
            ) : (
              <p className="notice warn" data-testid="live-unavailable">
                <strong>Flushing pilot data not available.</strong> {modeCfg.reason}
              </p>
            )}

            <section className="card controls" aria-label="Trip">
              {modeCfg.trips && modeCfg.trips.length > 0 && (
                <div className="field">
                  <label htmlFor="trip-select">Saved demo trips</label>
                  <select id="trip-select" value={tripId} onChange={(e) => chooseTrip(e.target.value)}>
                    <option value="">Choose a trip…</option>
                    {modeCfg.trips.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="endpoint">
                <PlaceSearch label="From" mode={mode} value={origin} onChange={(p) => { setOrigin(p); setTripId(''); }} />
                <div className="endpoint-actions">
                  <button
                    type="button"
                    className={`btn small ${armed === 'from' ? 'armed' : ''}`}
                    aria-pressed={armed === 'from'}
                    onClick={() => setArmed(armed === 'from' ? null : 'from')}
                  >
                    Set on map
                  </button>
                  <button type="button" className="btn small" onClick={useMyLocation}>
                    Use my location
                  </button>
                </div>
                {geoMsg && <p className="muted small" role="status">{geoMsg}</p>}
              </div>

              <div className="swap-row">
                <button
                  type="button"
                  className="btn small"
                  aria-label="Swap start and destination"
                  onClick={() => {
                    setOriginRaw(destination);
                    setDestinationRaw(origin);
                    resetTrip();
                  }}
                >
                  ⇅ Swap
                </button>
              </div>

              <div className="endpoint">
                <PlaceSearch label="To" mode={mode} value={destination} onChange={(p) => { setDestination(p); setTripId(''); }} />
                <div className="endpoint-actions">
                  <button
                    type="button"
                    className={`btn small ${armed === 'to' ? 'armed' : ''}`}
                    aria-pressed={armed === 'to'}
                    onClick={() => setArmed(armed === 'to' ? null : 'to')}
                  >
                    Set on map
                  </button>
                </div>
              </div>

              <LimitControl
                value={maxGap}
                min={config.slider.min_m}
                max={config.slider.max_m}
                step={config.slider.step_m}
                onChange={setMaxGap}
              />

              <div className="checks">
                <label>
                  <input type="checkbox" checked={showComparison} onChange={(e) => setShowComparison(e.target.checked)} />
                  Show shortest route comparison
                </label>
                <label>
                  <input type="checkbox" checked={basemap} onChange={(e) => setBasemap(e.target.checked)} />
                  Show basemap
                </label>
              </div>

              <details className="propose" data-testid="propose-bench">
                <summary>Propose a bench (planning experiment)</summary>
                <p className="muted small">
                  Place up to 3 hypothetical benches on mapped walkways to see how this trip would change. They are not
                  real seats and are not saved.
                </p>
                <div className="endpoint-actions">
                  <button
                    type="button"
                    className={`btn small ${armed === 'bench' ? 'armed' : ''}`}
                    aria-pressed={armed === 'bench'}
                    disabled={hypo.length >= 3 || !modeCfg.available}
                    onClick={() => setArmed(armed === 'bench' ? null : 'bench')}
                  >
                    Place a hypothetical bench
                  </button>
                  {hypo.length > 0 && (
                    <button type="button" className="btn small" onClick={() => setHypo([])}>
                      Clear all
                    </button>
                  )}
                </div>
                {hypo.length > 0 && (
                  <ul className="hypo-list">
                    {hypo.map((h, i) => (
                      <li key={`${h.lat},${h.lon}`}>
                        Hypothetical bench {i + 1}{' '}
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => setHypo((x) => x.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </details>

              <button
                type="button"
                className="btn primary"
                disabled={!origin || !destination}
                onClick={() => {
                  setEnabled(true);
                  planner.refresh();
                }}
              >
                Find route
              </button>
            </section>

            <button
              type="button"
              className="btn results-toggle"
              aria-expanded={resultsOpen}
              onClick={() => setResultsOpen((o) => !o)}
            >
              {resultsOpen ? 'Hide route details' : 'Show route details'}
            </button>
            <div className={resultsOpen ? '' : 'collapsed'}>
              <ResultCard
                result={result}
                pending={planner.pending}
                currentMaxGap={maxGap}
                networkError={planner.networkError}
                selectedLeg={selectedLeg}
                onSelectLeg={setSelectedLeg}
                excluded={excluded}
                seatsById={seatsById}
                onExclude={(id) => setExcluded((x) => (x.includes(id) ? x : [...x, id].sort()))}
                onRestore={(id) => setExcluded((x) => x.filter((v) => v !== id))}
                onPrint={() => window.print()}
                limitationNote={config.limitation_note}
              />
            </div>
          </aside>

          <div className="map-col">
            <MapSummary result={result} pending={planner.pending} currentMaxGap={maxGap} />
            <RouteMap
              config={mapConfig}
              basemap={basemap}
              seats={seats}
              result={result}
              origin={origin}
              destination={destination}
              armed={armed}
              onPick={onPick}
              selectedLeg={selectedLeg}
              onSelectLeg={setSelectedLeg}
              showComparison={showComparison}
              hypothetical={hypo}
              excluded={excluded}
              onExclude={(id) => setExcluded((x) => (x.includes(id) ? x : [...x, id].sort()))}
            />
          </div>
        </main>
      )}
      {page === 'plan' && result && (result.status === 'ok' || result.status === 'limit_unmet') && (
        <PrintSummary
          result={result}
          origin={origin}
          destination={destination}
          datasetDate={modeCfg.retrieved ? Object.values(modeCfg.retrieved)[0] ?? null : null}
        />
      )}
    </div>
  );
}
