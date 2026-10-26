import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchConfig, fetchSeats, getArea, prepareArea } from "./api/client";
import { useRoutePlanner } from "./hooks/useRoutePlanner";
import { LimitControl } from "./components/LimitControl";
import { PlaceSearch } from "./components/PlaceSearch";
import { ResultCard } from "./components/ResultCard";
import { PrintSummary } from "./components/PrintSummary";
import { HowItWorks } from "./components/HowItWorks";
import RouteMap from "./components/RouteMap";
import type {
  AppConfig,
  LatLon,
  Mode,
  ModeConfig,
  NamedPoint,
  Seat,
} from "./types";

const PREF_KEY = "restroute.maxGap";
const WORLD_CONFIG: ModeConfig = {
  mode: "nearby",
  available: true,
  area_name: "Your walking area",
  basemap_default: true,
};

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [mode, setMode] = useState<Mode>(
    window.location.hash === "#example" ? "synthetic_demo" : "nearby",
  );
  const [origin, setOriginRaw] = useState<NamedPoint | null>(null);
  const [destination, setDestinationRaw] = useState<NamedPoint | null>(null);
  const [maxGap, setMaxGapRaw] = useState(150);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [armed, setArmed] = useState<"from" | "to" | "bench" | null>(null);
  const [hypo, setHypo] = useState<LatLon[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [basemap, setBasemap] = useState(mode !== "synthetic_demo");
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [page, setPage] = useState<"plan" | "how">(
    window.location.hash === "#how" ? "how" : "plan",
  );
  const [resultsOpen, setResultsOpen] = useState(true);
  const [tripId, setTripId] = useState("");
  const [areaConfig, setAreaConfig] = useState<ModeConfig | null>(null);
  const [datasetId, setDatasetId] = useState<string>();
  const [loadingArea, setLoadingArea] = useState(false);
  const [areaMessage, setAreaMessage] = useState("");
  const [areaError, setAreaError] = useState("");
  const areaRequest = useRef<AbortController | null>(null);
  const areaRevision = useRef(0);
  const locationRevision = useRef(0);
  const mapColumn = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchConfig(ctrl.signal)
      .then((c) => {
        setConfig(c);
        let value = c.slider.default_m;
        try {
          const v = Number(localStorage.getItem(PREF_KEY));
          if (v >= c.slider.min_m && v <= c.slider.max_m) value = v;
        } catch {
          /* optional */
        }
        setMaxGapRaw(value);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setConfigError(true);
      });
    return () => {
      ctrl.abort();
      areaRequest.current?.abort();
      locationRevision.current++;
    };
  }, []);

  const modeCfg =
    mode === "synthetic_demo"
      ? config?.modes.synthetic_demo
      : (areaConfig ?? WORLD_CONFIG);
  useEffect(() => {
    if (mode !== "synthetic_demo" || !modeCfg?.routing_polygon) return;
    const ring = modeCfg.routing_polygon;
    const lons = ring.map((p) => p[0]),
      lats = ring.map((p) => p[1]);
    const ctrl = new AbortController();
    fetchSeats(
      mode,
      [
        Math.min(...lons),
        Math.min(...lats),
        Math.max(...lons),
        Math.max(...lats),
      ],
      ctrl.signal,
    )
      .then((r) => setSeats(r.seats))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [mode, modeCfg]);
  const planner = useRoutePlanner(
    {
      mode,
      datasetId,
      origin,
      destination,
      maxGap,
      excluded,
      hypothetical: hypo,
    },
    enabled,
  );
  const { result } = planner;

  const resetTrip = useCallback(() => {
    setExcluded([]);
    setSelectedLeg(null);
  }, []);
  const invalidate = () => {
    areaRevision.current++;
    areaRequest.current?.abort();
    locationRevision.current++;
    setLoadingArea(false);
    setAreaError("");
    setAreaMessage("");
    setGeoMsg(null);
    setEnabled(false);
    setArmed(null);
    planner.clear();
    setTripId("");
    setHypo([]);
    resetTrip();
  };
  const setOrigin = (p: NamedPoint | null) => {
    invalidate();
    setOriginRaw(p);
  };
  const setDestination = (p: NamedPoint | null) => {
    invalidate();
    setDestinationRaw(p);
  };
  const setMaxGap = (v: number) => {
    setMaxGapRaw(v);
    try {
      localStorage.setItem(PREF_KEY, String(v));
    } catch {
      /* optional */
    }
  };
  const switchMode = (next: Mode) => {
    invalidate();
    setMode(next);
    setOriginRaw(null);
    setDestinationRaw(null);
    setSeats([]);
    setDatasetId(undefined);
    setAreaConfig(null);
    setBasemap(next !== "synthetic_demo");
  };
  const go = (next: "plan" | "how" | "example") => {
    window.location.hash = next === "plan" ? "" : next;
    setPage(next === "how" ? "how" : "plan");
    if (next === "example" && mode !== "synthetic_demo")
      switchMode("synthetic_demo");
    if (next === "plan" && mode === "synthetic_demo") switchMode("nearby");
  };
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      setPage(hash === "#how" ? "how" : "plan");
      const next =
        hash === "#example"
          ? "synthetic_demo"
          : hash === "#how"
            ? mode
            : "nearby";
      if (next !== mode) switchMode(next);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  });

  const chooseTrip = (id: string) => {
    const trip = modeCfg?.trips?.find((t) => t.id === id);
    if (!trip) return;
    invalidate();
    setTripId(id);
    setOriginRaw(trip.from);
    setDestinationRaw(trip.to);
    if (trip.suggested_limits_m.length) setMaxGap(trip.suggested_limits_m[0]);
    setEnabled(true);
  };
  const armMap = (which: "from" | "to" | "bench") => {
    setArmed(armed === which ? null : which);
    if (window.matchMedia("(max-width: 820px)").matches)
      mapColumn.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const onPick = (lat: number, lon: number) => {
    if (armed === "bench") {
      setHypo((h) => (h.length >= 3 ? h : [...h, { lat, lon }]));
      setArmed(null);
      return;
    }
    const point = {
      name:
        armed === "from"
          ? "Start selected on map"
          : "Destination selected on map",
      lat,
      lon,
    };
    if (armed === "from") setOrigin(point);
    if (armed === "to") setDestination(point);
    setArmed(null);
  };
  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoMsg("Location is unavailable. Search for a place or use the map.");
      return;
    }
    const ticket = ++locationRevision.current;
    setGeoMsg("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (ticket !== locationRevision.current) return;
        setOrigin({
          name: "My location",
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        });
        setGeoMsg(
          `Location found. Accuracy about ${Math.round(pos.coords.accuracy)} m; adjust the pin if needed.`,
        );
      },
      () => {
        if (ticket === locationRevision.current)
          setGeoMsg("Location unavailable. Search for a place or use the map.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  const findRoute = async () => {
    if (!origin || !destination) return;
    if (mode !== "nearby") {
      setEnabled(true);
      planner.refresh();
      return;
    }
    areaRequest.current?.abort();
    const ctrl = new AbortController();
    areaRequest.current = ctrl;
    const ticket = ++areaRevision.current;
    setEnabled(false);
    planner.clear();
    setLoadingArea(true);
    setAreaError("");
    setAreaMessage("Getting your walking area ready…");
    try {
      let area = await prepareArea(origin, destination, ctrl.signal);
      const deadline = Date.now() + 240000;
      while (area.status === "loading") {
        if (ctrl.signal.aborted || ticket !== areaRevision.current) return;
        setAreaMessage(area.message);
        if (Date.now() > deadline)
          throw new Error(
            "This area is taking longer than expected. Please try again shortly.",
          );
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            ctrl.signal.removeEventListener("abort", abort);
            resolve();
          }, 1200);
          ctrl.signal.addEventListener("abort", abort, { once: true });
        });
        area = await getArea(area.dataset_id!, ctrl.signal);
      }
      if (ticket !== areaRevision.current || ctrl.signal.aborted) return;
      if (area.status !== "ready" || !area.config || !area.dataset_id)
        throw new Error(area.message);
      setDatasetId(area.dataset_id);
      setAreaConfig(area.config);
      setSeats(area.seats ?? []);
      setEnabled(true);
      setResultsOpen(true);
    } catch (e) {
      if (ticket === areaRevision.current && (e as Error).name !== "AbortError")
        setAreaError(
          (e as Error).message || "Could not load this area. Please try again.",
        );
    } finally {
      if (ticket === areaRevision.current) setLoadingArea(false);
    }
  };
  const seatsById = useMemo(
    () => Object.fromEntries(seats.map((s) => [s.id, s])),
    [seats],
  );
  const onExclude = (id: string) =>
    setExcluded((x) => (x.includes(id) ? x : [...x, id].sort()));

  if (configError)
    return (
      <main className="fatal">
        <h1>Let’s get you walking.</h1>
        <p role="alert">
          Rest Route couldn’t connect to its server. Please try again.
        </p>
        <button
          className="btn primary"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </main>
    );
  if (!config || !modeCfg)
    return (
      <main className="fatal" role="status">
        <span className="spinner" /> Opening Rest Route…
      </main>
    );
  const hasResult = !!result || planner.pending || !!planner.networkError;

  return (
    <div className="app">
      <header className="topbar no-print">
        <button
          className="brand"
          onClick={() => go("plan")}
          aria-label="Rest Route home"
        >
          <span className="logo" aria-hidden="true">
            <svg
              width="27"
              height="27"
              viewBox="0 0 32 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M6 9h20M6 14h20M4 19h24M8 19v7m16-7v7M8 9v10m16-10v10" />
            </svg>
          </span>
          <span>
            rest route<span className="brand-dot">.</span>
          </span>
        </button>
        <span className="header-note">A place to pause, along the way.</span>
        <nav aria-label="Pages">
          <button
            className={`link ${page === "how" ? "active" : ""}`}
            onClick={() => go(page === "how" ? "plan" : "how")}
          >
            {page === "how" ? "Back to planner" : "How it works"}{" "}
            <span aria-hidden="true">↗</span>
          </button>
        </nav>
      </header>
      {page === "how" ? (
        <main className="how-wrap">
          <HowItWorks
            onBack={() => go("plan")}
            onExample={() => go("example")}
            limitationNote={config.limitation_note}
          />
        </main>
      ) : (
        <main className="layout no-print">
          <aside className="panel" ref={panel}>
            <div className="planner-intro">
              <p className="eyebrow">WALK AT YOUR OWN PACE</p>
              <h1 className="desktop-intro">
                A little rest.
                <br />
                <em>A better walk.</em>
              </h1>
              <h1 className="phone-intro">Plan your walk.</h1>
              <p>Find a walking route with places to sit along the way.</p>
            </div>
            {mode === "synthetic_demo" && (
              <div className="notice demo" data-testid="demo-indicator">
                <strong>You’re trying a fictional example.</strong>
                <p>
                  These streets and benches are for exploring how routes change.
                </p>
                <button className="text-button" onClick={() => go("plan")}>
                  ← Plan a real walk
                </button>
              </div>
            )}
            <section className="controls" aria-label="Plan your walk">
              {mode === "synthetic_demo" && (
                <div className="field">
                  <label htmlFor="trip-select">Example walks</label>
                  <select
                    id="trip-select"
                    value={tripId}
                    onChange={(e) => chooseTrip(e.target.value)}
                  >
                    <option value="">Choose an example…</option>
                    {modeCfg.trips?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="journey-fields">
                <div className="endpoint">
                  <span className="endpoint-letter" aria-hidden="true">
                    A
                  </span>
                  <div className="endpoint-body">
                    <PlaceSearch
                      key={`from-${mode}`}
                      label="From"
                      mode={mode}
                      value={origin}
                      onChange={setOrigin}
                    />
                    <div className="endpoint-actions">
                      {mode === "nearby" && (
                        <button className="text-button" onClick={useMyLocation}>
                          ◎ Use my location
                        </button>
                      )}
                      <button
                        className={`text-button ${armed === "from" ? "armed" : ""}`}
                        aria-pressed={armed === "from"}
                        onClick={() => armMap("from")}
                      >
                        Choose on map
                      </button>
                    </div>
                  </div>
                </div>
                <div className="swap-row">
                  <button
                    className="swap-button"
                    disabled={!origin || !destination}
                    aria-label="Swap start and destination"
                    onClick={() => {
                      invalidate();
                      setOriginRaw(destination);
                      setDestinationRaw(origin);
                    }}
                  >
                    ⇅
                  </button>
                </div>
                <div className="endpoint">
                  <span
                    className="endpoint-letter destination"
                    aria-hidden="true"
                  >
                    B
                  </span>
                  <div className="endpoint-body">
                    <PlaceSearch
                      key={`to-${mode}`}
                      label="To"
                      mode={mode}
                      value={destination}
                      onChange={setDestination}
                    />
                    <div className="endpoint-actions">
                      <button
                        className={`text-button ${armed === "to" ? "armed" : ""}`}
                        aria-pressed={armed === "to"}
                        onClick={() => armMap("to")}
                      >
                        Choose on map
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              {geoMsg && (
                <p className="muted small" role="status">
                  {geoMsg}
                </p>
              )}
              <p className="search-hint">
                {mode === "nearby"
                  ? "Include a city in your search, then press Enter or ⌕."
                  : "Choose an example above or place both pins on a path."}
              </p>
              <LimitControl
                value={maxGap}
                min={config.slider.min_m}
                max={config.slider.max_m}
                step={config.slider.step_m}
                onChange={setMaxGap}
              />
              <button
                className="btn primary find-route"
                disabled={!origin || !destination || loadingArea}
                onClick={() => void findRoute()}
              >
                {loadingArea ? (
                  <>
                    <span className="spinner" /> Loading your area…
                  </>
                ) : (
                  <>
                    Find my walk <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
              {loadingArea && (
                <div className="loading-area" role="status">
                  <strong>{areaMessage}</strong>
                  <p>
                    New areas can take a minute or two. Changes to your rest
                    distance will be quicker.
                  </p>
                  <button className="text-button" onClick={invalidate}>
                    Cancel
                  </button>
                </div>
              )}
              {areaError && (
                <p className="notice error" role="alert">
                  {areaError}
                </p>
              )}
              {!loadingArea && !hasResult && (
                <p className="button-hint">
                  {!origin || !destination
                    ? "Choose both places to get started."
                    : "Ready when you are."}
                </p>
              )}
            </section>
            {hasResult && (
              <>
                <button
                  className="btn results-toggle"
                  aria-expanded={resultsOpen}
                  onClick={() => setResultsOpen((o) => !o)}
                >
                  {resultsOpen ? "Hide route details" : "Show route details"}
                </button>
                <div className={resultsOpen ? "" : "collapsed"}>
                  <ResultCard
                    result={result}
                    pending={planner.pending}
                    currentMaxGap={maxGap}
                    networkError={planner.networkError}
                    selectedLeg={selectedLeg}
                    onSelectLeg={setSelectedLeg}
                    excluded={excluded}
                    seatsById={seatsById}
                    onExclude={onExclude}
                    onRestore={(id) =>
                      setExcluded((x) => x.filter((v) => v !== id))
                    }
                    onPrint={() => window.print()}
                    limitationNote={config.limitation_note}
                  />
                </div>
              </>
            )}
            <details className="more-options">
              <summary>Map options & experiments</summary>
              <div className="checks">
                <label>
                  <input
                    type="checkbox"
                    checked={showComparison}
                    onChange={(e) => setShowComparison(e.target.checked)}
                  />{" "}
                  Compare with the shortest walk
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={basemap}
                    onChange={(e) => setBasemap(e.target.checked)}
                  />{" "}
                  Show street map
                </label>
              </div>
              <details className="propose" data-testid="propose-bench">
                <summary>Try adding a bench</summary>
                <p className="muted small">
                  See how up to three hypothetical benches would change your
                  route. These are not real seats.
                </p>
                <button
                  className="btn small"
                  aria-pressed={armed === "bench"}
                  disabled={
                    hypo.length >= 3 || (mode === "nearby" && !datasetId)
                  }
                  onClick={() => armMap("bench")}
                >
                  Place a hypothetical bench
                </button>
                {hypo.length > 0 && (
                  <button className="btn small" onClick={() => setHypo([])}>
                    Clear all
                  </button>
                )}
              </details>
            </details>
            <footer className="planner-footer">
              <p>
                For neighborhood walks up to 3 km apart. Bench coverage varies
                by location.
              </p>
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                © OpenStreetMap contributors
              </a>
              <span> · </span>
              <button className="text-button" onClick={() => go("how")}>
                About the data
              </button>
            </footer>
          </aside>
          <div className="map-col" ref={mapColumn}>
            {!result && !armed && (
              <div className="map-welcome">
                <span className="eyebrow">
                  {mode === "synthetic_demo"
                    ? "FICTIONAL EXAMPLE"
                    : "YOUR NEXT WALK"}
                </span>
                <h2>
                  {origin
                    ? destination
                      ? "Your walk starts here."
                      : "Now, where to?"
                    : "Where would you like to go?"}
                </h2>
                <p>
                  {origin
                    ? destination
                      ? "Choose your rest distance and find your walk."
                      : "Search for a destination or choose it on the map."
                    : "Search for a place, use your location, or choose a point on the map."}
                </p>
              </div>
            )}
            <RouteMap
              config={modeCfg}
              basemap={basemap}
              seats={seats}
              result={result}
              origin={origin}
              destination={destination}
              armed={armed}
              onPick={onPick}
              onCancelPick={() => setArmed(null)}
              selectedLeg={selectedLeg}
              onSelectLeg={setSelectedLeg}
              showComparison={showComparison}
              hypothetical={hypo}
              excluded={excluded}
              onExclude={onExclude}
            />
            {areaConfig && mode === "nearby" && (
              <div className="area-caption">
                {areaConfig.counts?.eligible_seats ?? 0} usable seat records in
                the loaded area · Dashed outline shows coverage
              </div>
            )}
          </div>
        </main>
      )}
      {page === "plan" && (
        <nav className="phone-nav no-print" aria-label="Planner views">
          <button
            onClick={() =>
              panel.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              })
            }
          >
            ↗ Plan walk
          </button>
          <button
            onClick={() =>
              mapColumn.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              })
            }
          >
            ⌖ View map
          </button>
        </nav>
      )}
      {page === "plan" &&
        result &&
        (result.status === "ok" || result.status === "limit_unmet") && (
          <PrintSummary
            result={result}
            origin={origin}
            destination={destination}
            datasetDate={
              modeCfg.retrieved
                ? (Object.values(modeCfg.retrieved)[0] ?? null)
                : null
            }
          />
        )}
    </div>
  );
}
