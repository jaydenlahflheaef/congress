import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  fetchConfig,
  fetchSeats,
  getArea,
  prepareArea,
  refreshElevators,
} from "./api/client";
import { useRoutePlanner } from "./hooks/useRoutePlanner";
import { useBottomEdge, useMediaQuery } from "./hooks/useLayout";
import { useLiveLocation } from "./hooks/useLiveLocation";
import { useCompass } from "./hooks/useCompass";
import { LimitControl } from "./components/LimitControl";
import { PlaceSearch } from "./components/PlaceSearch";
import { ResultCard } from "./components/ResultCard";
import { PrintSummary } from "./components/PrintSummary";
import { HowItWorks } from "./components/HowItWorks";
import { ThemeToggle } from "./components/ThemeToggle";
import { Icon } from "./components/Icon";
import { Sheet, type Snap } from "./components/Sheet";
import MapView from "./components/MapView";
import { STATUS_HEADINGS, fmtM } from "./format";
import type {
  AppConfig,
  LatLon,
  Mode,
  ModeConfig,
  NamedPoint,
  PublicRestroom,
  Seat,
  Trip,
} from "./types";

const PREF_KEY = "restroute.maxGap";
const SIDE_PANEL_PX = 400;

function IconButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${pressed ? "armed" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

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
  const [showRestrooms, setShowRestrooms] = useState(false);
  const [focusedRestroomId, setFocusedRestroomId] = useState<string | null>(
    null,
  );
  const [seats, setSeats] = useState<Seat[]>([]);
  const [restrooms, setRestrooms] = useState<PublicRestroom[]>([]);
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null);
  const [walkingLeg, setWalkingLeg] = useState<number | null>(null);
  const [locateOn, setLocateOn] = useState(false);
  const [followPaused, setFollowPaused] = useState(false);
  const [centerToken, setCenterToken] = useState(0);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [page, setPage] = useState<"plan" | "how">(
    window.location.hash === "#how" ? "how" : "plan",
  );
  const [tripId, setTripId] = useState("");
  const [areaConfig, setAreaConfig] = useState<ModeConfig | null>(null);
  const [datasetId, setDatasetId] = useState<string>();
  const [loadingArea, setLoadingArea] = useState(false);
  const [areaMessage, setAreaMessage] = useState("");
  const [areaError, setAreaError] = useState("");
  const [snap, setSnap] = useState<Snap>("half");
  const [sheetH, setSheetH] = useState(0);
  const areaRequest = useRef<AbortController | null>(null);
  const areaRevision = useRef(0);
  const locationRevision = useRef(0);
  const [topEl, setTopEl] = useState<HTMLElement | null>(null);
  // Where the floating search card ends, measured on screen so it includes
  // the iPhone status-bar inset; the raised sheet stops below it.
  const topBottom = useBottomEdge(topEl, 140);
  const mobile = useMediaQuery("(max-width: 820px)");

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

  // Live position and facing direction, while walking or after pressing Locate.
  const tracking = walkingLeg !== null || locateOn;
  const { fix, denied } = useLiveLocation(tracking);
  const compass = useCompass(tracking);
  const heading = compass.heading ?? fix?.travelHeading ?? null;
  const follow = walkingLeg !== null && !followPaused;
  useEffect(() => {
    if (denied && tracking) {
      setGeoMsg("Location is off for EzWay. Allow it in Settings to see where you are.");
      setLocateOn(false);
    }
  }, [denied, tracking]);

  const modeCfg =
    mode === "synthetic_demo"
      ? config?.modes.synthetic_demo
      : (areaConfig ?? config?.modes.nearby);
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
    setWalkingLeg(null);
    setFocusedRestroomId(null);
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
    setRestrooms([]);
    setDatasetId(undefined);
    setAreaConfig(null);
    setSnap("half");
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
    setSnap("peek");
  };
  const armMap = (which: "from" | "to" | "bench") => {
    setArmed(armed === which ? null : which);
    // Lower the sheet so the map is free to tap.
    setSnap("peek");
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
    setSnap("half");
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
  const findRoute = async (from = origin, to = destination) => {
    if (!from || !to) return;
    if (mode !== "nearby") {
      setEnabled(true);
      planner.refresh();
      setSnap("peek");
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
      let area = await prepareArea(from, to, ctrl.signal);
      const deadline = Date.now() + 240000;
      while (area.status === "loading") {
        if (ctrl.signal.aborted || ticket !== areaRevision.current) return;
        setAreaMessage(area.message);
        if (Date.now() > deadline)
          throw new Error(
            "This area is still loading. Press Find my walk again in a minute; loading continues in the background.",
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
      setRestrooms(area.restrooms ?? []);
      setEnabled(true);
      // Show the route on the map; the summary and slider stay in view.
      setSnap("peek");
    } catch (e) {
      if (ticket === areaRevision.current && (e as Error).name !== "AbortError")
        setAreaError(
          (e as Error).message || "Could not load this area. Please try again.",
        );
    } finally {
      if (ticket === areaRevision.current) setLoadingArea(false);
    }
  };
  const tryExample = (trip: Trip) => {
    invalidate();
    setOriginRaw(trip.from);
    setDestinationRaw(trip.to);
    if (trip.suggested_limits_m.length) setMaxGap(trip.suggested_limits_m[0]);
    void findRoute(trip.from, trip.to);
  };
  const onRefreshElevators = async () => {
    if (!origin || !destination) return;
    try {
      await refreshElevators(origin, destination, mode);
      planner.refresh();
    } catch {
      /* keep existing snapshot if refresh fails */
    }
  };
  const startWalkLeg = (legIndex: number | null) => {
    // iPhones only share the compass after a tap, so ask right here.
    if (legIndex !== null && walkingLeg === null) {
      void compass.request();
      setFollowPaused(false);
      setCenterToken((t) => t + 1);
    }
    setWalkingLeg(legIndex);
    setSelectedLeg(legIndex);
    if (legIndex !== null) {
      setSnap("peek");
    }
  };
  // The Locate button: show where you are, or jump back to you after moving the map.
  const locate = () => {
    if (!tracking) {
      void compass.request();
      setLocateOn(true);
    } else if (!fix && !denied) {
      setGeoMsg("Finding your location…");
    }
    setFollowPaused(false);
    setCenterToken((t) => t + 1);
  };
  const examples = mode === "nearby" ? (config?.modes.nearby?.trips ?? []) : [];
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
          EzWay couldn’t connect to its server. Please try again.
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
        <span className="spinner" /> Opening EzWay…
      </main>
    );
  const hasResult = !!result || planner.pending || !!planner.networkError;
  const hasRoute =
    !!result && (result.status === "ok" || result.status === "limit_unmet");
  const canStartWalk = hasRoute && result.legs.length > 0;
  const padding = mobile
    ? { top: topBottom + 16, right: 24, bottom: sheetH + 24, left: 24 }
    : { top: 40, right: 40, bottom: 40, left: SIDE_PANEL_PX + 48 };

  const head = (
    <>
      {mode === "synthetic_demo" && (
        <div className="notice demo" data-testid="demo-indicator">
          <strong>You’re trying a fictional example.</strong>{" "}
          <button className="text-button" onClick={() => go("plan")}>
            <Icon name="arrowLeft" size={16} /> Plan a real walk
          </button>
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
        </div>
      )}
      {result && (
        <div className="route-peek">
          <div>
            <strong className={`peek-status status-${result.status}`}>
              {STATUS_HEADINGS[result.status] ?? result.status}
            </strong>
            {hasRoute && (
              <span className="peek-numbers">
                <span>{fmtM(result.total_distance_m)}</span> ·{" "}
                <span>
                  {result.rest_count} {result.rest_count === 1 ? "rest" : "rests"}
                </span>{" "}
                · <span>longest stretch {fmtM(result.longest_gap_m)}</span>
              </span>
            )}
          </div>
          {canStartWalk && (
            <button
              type="button"
              className="btn primary start"
              onClick={() =>
                startWalkLeg(walkingLeg !== null ? null : (selectedLeg ?? 1))
              }
              aria-pressed={walkingLeg !== null}
              aria-label={
                walkingLeg !== null
                  ? "End walk guidance"
                  : `Start walking: guide to ${result.legs[0]?.to_label ?? "the first stop"}`
              }
            >
              <Icon name="walk" /> {walkingLeg !== null ? "End walk" : "Start"}
            </button>
          )}
        </div>
      )}
      <LimitControl
        value={maxGap}
        min={config.slider.min_m}
        max={config.slider.max_m}
        step={config.slider.step_m}
        onChange={setMaxGap}
      />
      {(!enabled || loadingArea) && (
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
              Find my walk <Icon name="arrowRight" size={24} />
            </>
          )}
        </button>
      )}
      {loadingArea && (
        <div className="loading-area" role="status">
          <strong>{areaMessage}</strong>
          <p>
            New areas usually take a few seconds. Changes to your rest distance
            will be quicker.
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
      {!loadingArea && !hasResult && !enabled && (
        <p className="button-hint">
          {!origin || !destination
            ? "Choose a start and a destination above."
            : "Ready when you are."}
        </p>
      )}
    </>
  );

  return (
    <div
      className="app"
      style={{ "--top-bottom": `${topBottom}px`, "--sheet-h": `${mobile ? sheetH : 0}px` } as CSSProperties}
    >
      <MapView
        apiKey={config.google_maps?.api_key ?? null}
        config={modeCfg}
        seats={seats}
        restrooms={restrooms}
        showRestrooms={showRestrooms}
        focusedRestroomId={focusedRestroomId}
        onFocusRestroom={setFocusedRestroomId}
        you={fix}
        heading={heading}
        follow={follow}
        centerToken={centerToken}
        onUserMoved={() => setFollowPaused(true)}
        walkingLeg={walkingLeg}
        onStartWalkLeg={startWalkLeg}
        result={result}
        origin={origin}
        destination={destination}
        armed={armed}
        hypothetical={hypo}
        onPick={onPick}
        onCancelPick={() => setArmed(null)}
        onMapTap={() => setSnap("peek")}
        selectedLeg={selectedLeg}
        onSelectLeg={(i) => {
          setSelectedLeg(i);
          if (walkingLeg !== null && i !== null) setWalkingLeg(i);
        }}
        showComparison={showComparison}
        excluded={excluded}
        onExclude={onExclude}
        padding={padding}
      />
      <button
        type="button"
        className={`map-fab ${tracking && fix ? "on" : ""} ${follow || !walkingLeg ? "" : "paused"} ${walkingLeg !== null && followPaused ? "paused" : ""}`}
        aria-label={walkingLeg !== null && followPaused ? "Re-center on me" : tracking ? "Center on me" : "Show where I am"}
        title={walkingLeg !== null && followPaused ? "Re-center on me" : "Show where I am"}
        data-testid="locate-button"
        onClick={locate}
      >
        <Icon name="locate" size={24} />
      </button>

      <header className="top no-print" ref={setTopEl}>
        <div className="search-card">
          <div className="brand-row">
            <button
              className="brand"
              onClick={() => go("plan")}
              aria-label="EzWay home"
            >
              <span className="logo" aria-hidden="true">
                <Icon name="bench" />
              </span>
              <span>
                Ez<span className="brand-way">Way</span>
              </span>
            </button>
            <ThemeToggle />
            <button className="link" onClick={() => go("how")}>
              How it works
            </button>
          </div>
          <div className="journey">
            <div className="endpoint-row">
              <span className="endpoint-dot" aria-hidden="true">
                A
              </span>
              <PlaceSearch
                key={`from-${mode}`}
                label="From"
                hideLabel
                placeholder="Choose start"
                mode={mode}
                value={origin}
                onChange={setOrigin}
              />
              {mode === "nearby" && (
                <IconButton label="Use my location" onClick={useMyLocation}>
                  <Icon name="locate" />
                </IconButton>
              )}
              <IconButton
                label="Choose start on map"
                pressed={armed === "from"}
                onClick={() => armMap("from")}
              >
                <Icon name="pin" />
              </IconButton>
            </div>
            <div className="endpoint-row">
              <span className="endpoint-dot destination" aria-hidden="true">
                B
              </span>
              <PlaceSearch
                key={`to-${mode}`}
                label="To"
                hideLabel
                placeholder="Choose destination"
                mode={mode}
                value={destination}
                onChange={setDestination}
              />
              <IconButton
                label="Choose destination on map"
                pressed={armed === "to"}
                onClick={() => armMap("to")}
              >
                <Icon name="pin" />
              </IconButton>
              <IconButton
                label="Swap start and destination"
                disabled={!origin || !destination}
                onClick={() => {
                  invalidate();
                  setOriginRaw(destination);
                  setDestinationRaw(origin);
                }}
              >
                <Icon name="swap" />
              </IconButton>
            </div>
          </div>
        </div>
        {geoMsg && (
          <p className="toast" role="status">
            {geoMsg}
          </p>
        )}
      </header>

      <Sheet
        snap={snap}
        onSnap={setSnap}
        head={head}
        topInset={topBottom + 8}
        mobile={mobile}
        onHeight={setSheetH}
      >
        {hasResult && (
          <ResultCard
            result={result}
            pending={planner.pending}
            currentMaxGap={maxGap}
            networkError={planner.networkError}
            selectedLeg={selectedLeg}
            onSelectLeg={setSelectedLeg}
            walkingLeg={walkingLeg}
            onStartWalkLeg={startWalkLeg}
            excluded={excluded}
            seatsById={seatsById}
            onExclude={onExclude}
            onRestore={(id) => setExcluded((x) => x.filter((v) => v !== id))}
            onPrint={() => window.print()}
            limitationNote={config.limitation_note}
            onRefreshElevators={onRefreshElevators}
            onFocusRestroom={(id) => {
              setShowRestrooms(true);
              setFocusedRestroomId(id);
              setSnap("peek");
            }}
            onUseAsDestination={(pt) => {
              if (!origin) return;
              invalidate();
              setDestinationRaw(pt);
              void findRoute(origin, pt);
            }}
          />
        )}
        {hasRoute && (
          <p className="map-legend" aria-hidden="true">
            <span>
              <i className="sw teal" /> within limit
            </span>
            <span>
              <i className="sw amber" /> over limit
            </span>
            {showComparison && (
              <span>
                <i className="sw gray" /> shortest walk
              </span>
            )}
            <span>
              <i className="dot eligible" /> seat on record
            </span>
            <span>
              <i className="dot ineligible" /> leaning bar / shelter
            </span>
            {showRestrooms && (
              <span>
                <i className="dot restroom" /> public restroom
              </span>
            )}
          </p>
        )}
        {areaConfig && mode === "nearby" && (
          <p className="area-caption">
            {areaConfig.counts?.eligible_seats ?? 0} usable seat records in{" "}
            {areaConfig.area_name === "Your walking area"
              ? "the loaded area"
              : areaConfig.area_name}{" "}
            · dashed outline shows coverage
            {areaConfig.counts?.thinned_seats ? (
              <>
                <br />
                Dense area: {areaConfig.counts.thinned_seats} more benches were
                skipped so the benches used are at least{" "}
                {Math.round(areaConfig.counts.thin_spacing_m ?? 0)} m apart.
                Routes only use the benches kept.
              </>
            ) : null}
          </p>
        )}
        {!hasResult && !loadingArea && examples.length > 0 && (
          <div className="examples" data-testid="examples">
            <p className="examples-title">Or try an example walk:</p>
            {examples.map((t) => (
              <button
                key={t.id}
                className="btn small example"
                onClick={() => tryExample(t)}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
        {!hasResult && (
          <p className="search-hint">
            {mode === "nearby"
              ? "Search for a place or address in New York City, then press Enter. You can also use your location or choose a spot on the map with the buttons beside each box."
              : "Choose an example above or place both pins on a path."}
          </p>
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
                checked={showRestrooms}
                onChange={(e) => setShowRestrooms(e.target.checked)}
              />{" "}
              Show public restrooms on map
            </label>
          </div>
          <details className="propose" data-testid="propose-bench">
            <summary>Try adding a bench</summary>
            <p className="muted small">
              See how up to three hypothetical benches would change your route.
              These are not real seats.
            </p>
            <button
              className="btn small"
              aria-pressed={armed === "bench"}
              disabled={hypo.length >= 3 || (mode === "nearby" && !datasetId)}
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
            For walks in New York City, up to 3 km (about 1.9 miles) apart.
            Bench coverage varies by neighborhood.
          </p>
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            Walkways and benches © OpenStreetMap contributors
          </a>
          <span> · </span>
          <button className="text-button" onClick={() => go("how")}>
            About the data
          </button>
        </footer>
      </Sheet>

      {page === "how" && (
        <div className="how-overlay">
          <main className="how-wrap">
            <HowItWorks
              onBack={() => go("plan")}
              onExample={() => go("example")}
              limitationNote={config.limitation_note}
            />
          </main>
        </div>
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
