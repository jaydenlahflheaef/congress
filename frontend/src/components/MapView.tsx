/// <reference types="google.maps" />
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  APILoadingStatus,
  APIProvider,
  InfoWindow,
  Map,
  Polygon,
  Polyline,
  useApiLoadingStatus,
  useMap,
} from "@vis.gl/react-google-maps";
import type {
  LatLon,
  ModeConfig,
  NamedPoint,
  PublicRestroom,
  RouteResponse,
  Seat,
} from "../types";
import { fmtM } from "../format";

const COLORS = {
  teal: "#d2462a",
  amber: "#f6a21e",
  gray: "#8a7d73",
  ink: "#3a2a20",
};

// EzWay's own map style. Google's place, shop and transit icons are hidden so
// only EzWay's markers show; street, neighborhood, park and station names stay.
const HIDE_GOOGLE_ICONS: google.maps.MapTypeStyle[] = [
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", elementType: "labels.text", stylers: [{ visibility: "on" }] },
  { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];
const LIGHT_MAP: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#f8f0e6" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6d5a6b" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#fffaf3" }] },
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#f3e6d8" }] },
  { featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#ffffff" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#eddccc" }] },
  { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#f8dcc3" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#bcdcf3" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#d6eed8" }] },
  { featureType: "transit.line", elementType: "geometry", stylers: [{ color: "#e2cbbb" }] },
  ...HIDE_GOOGLE_ICONS,
];
const DARK_MAP: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#251d2b" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#c4b2c2" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1c1622" }] },
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#2c2333" }] },
  { featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#3b2f43" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#2a2230" }] },
  { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#55405a" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#1f3247" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1f3a2c" }] },
  { featureType: "transit.line", elementType: "geometry", stylers: [{ color: "#43354a" }] },
  ...HIDE_GOOGLE_ICONS,
];

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Props {
  apiKey: string | null;
  config: ModeConfig;
  seats: Seat[];
  restrooms?: PublicRestroom[];
  showRestrooms?: boolean;
  result: RouteResponse | null;
  origin: NamedPoint | null;
  destination: NamedPoint | null;
  armed: "from" | "to" | "bench" | null;
  hypothetical: LatLon[];
  onPick: (lat: number, lon: number) => void;
  onCancelPick: () => void;
  /** A tap on the map that is not choosing a point (lowers the sheet on phones). */
  onMapTap: () => void;
  selectedLeg: number | null;
  onSelectLeg: (i: number | null) => void;
  showComparison: boolean;
  excluded: string[];
  onExclude: (id: string) => void;
  /** Screen space covered by the search card and the sheet, kept clear when fitting the view. */
  padding: MapPadding;
}

type Pt = [number, number]; // [lon, lat], as in GeoJSON
const toPath = (coords: Pt[]) => coords.map(([lng, lat]) => ({ lat, lng }));

/** A dashed line: Google polylines draw dashes as repeated symbols. */
function dashes(color: string, repeat: string, scale = 3) {
  return [
    {
      icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: color, scale },
      offset: "0",
      repeat,
    },
  ];
}

/** Follows the light/dark switch, which sets data-theme on <html>. */
function useDarkTheme() {
  const read = () => document.documentElement.dataset.theme === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/**
 * EzWay's own map marker: any HTML, centred on a coordinate. Built on an
 * OverlayView, so it works with a styled map (Google's AdvancedMarker needs a
 * Map ID, which would ignore the style above).
 */
function HtmlMarker({
  lat,
  lng,
  zIndex = 0,
  title,
  onClick,
  children,
}: {
  lat: number;
  lng: number;
  zIndex?: number;
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const map = useMap();
  const el = useMemo(() => {
    const d = document.createElement("div");
    d.className = "html-marker";
    return d;
  }, []);
  const overlay = useRef<google.maps.OverlayView | null>(null);
  const pos = useRef({ lat, lng });
  pos.current = { lat, lng };
  const click = useRef(onClick);
  click.current = onClick;
  const clickable = !!onClick;

  useEffect(() => {
    if (!map) return;
    const o = new google.maps.OverlayView();
    o.onAdd = () => {
      // The top pane keeps every marker above the route lines; markers that
      // cannot be tapped let taps fall through to the map.
      el.style.pointerEvents = clickable ? "auto" : "none";
      o.getPanes()!.overlayMouseTarget.appendChild(el);
    };
    o.draw = () => {
      const p = o
        .getProjection()
        ?.fromLatLngToDivPixel(new google.maps.LatLng(pos.current.lat, pos.current.lng));
      if (p) {
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
      }
    };
    o.onRemove = () => el.remove();
    o.setMap(map);
    overlay.current = o;
    return () => {
      o.setMap(null);
      overlay.current = null;
    };
  }, [map, el, clickable]);
  useEffect(() => overlay.current?.draw(), [lat, lng]);
  useEffect(() => {
    el.style.zIndex = String(zIndex);
    el.title = title ?? "";
  }, [el, zIndex, title]);
  useEffect(() => {
    if (!clickable) return;
    el.classList.add("clickable");
    // Taps on the marker should not also count as taps on the map.
    google.maps.OverlayView.preventMapHitsAndGesturesFrom(el);
    const handler = () => click.current?.();
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [el, clickable]);
  return createPortal(children, el);
}

function FitTo({
  points,
  token,
  padding,
}: {
  points: Pt[];
  token: string;
  padding: MapPadding;
}) {
  const map = useMap();
  useEffect(() => {
    if (!map || !points.length) return;
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    const bounds = {
      west: Math.min(...lons),
      east: Math.max(...lons),
      south: Math.min(...lats),
      north: Math.max(...lats),
    };
    // A single point would zoom all the way in; show its street instead.
    if (bounds.east - bounds.west < 1e-5 && bounds.north - bounds.south < 1e-5) {
      map.setZoom(17);
      map.panTo({ lat: bounds.north, lng: bounds.west });
    } else {
      map.fitBounds(bounds, padding);
    }
    // Refit only when the token changes, not when the sheet moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, token]);
  return null;
}

/** Lets browser tests convert coordinates to screen positions. */
function TestHook() {
  const map = useMap();
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    if (map && w.__REST_ROUTE_TEST__) w.__restRouteMap = map;
  }, [map]);
  return null;
}

function Pin({ text, cls }: { text: string; cls: string }) {
  return <div className={`map-pin ${cls}`}>{text}</div>;
}

/** If anything in the map throws, keep the rest of the app working. */
class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="map-missing" role="status" data-testid="map-error">
        The map couldn’t be shown. Your route is still listed in the panel.
      </div>
    ) : (
      this.props.children
    );
  }
}

/** Shown when Google refuses the key or its script cannot load. */
function LoadProblem() {
  const status = useApiLoadingStatus();
  if (status !== APILoadingStatus.FAILED && status !== APILoadingStatus.AUTH_FAILURE)
    return null;
  return (
    <div className="map-banner warn" role="status" data-testid="map-error">
      Google Maps couldn’t load. Your route is still listed in the panel.
    </div>
  );
}

/** Everything drawn on the map; only rendered once Google Maps has loaded. */
function Overlays(
  props: Props & {
    popup: string | null;
    setPopup: (id: string | null) => void;
    rrPopup: string | null;
    setRrPopup: (id: string | null) => void;
  },
) {
  const status = useApiLoadingStatus();
  const { config, result } = props;
  const hasRoute =
    !!result && (result.status === "ok" || result.status === "limit_unmet");
  const legs = hasRoute ? (result!.route_geojson?.features ?? []) : [];
  const stopIds = new Set(hasRoute ? result!.stops.map((s) => s.id) : []);
  const service = (config.service_polygon ?? []) as Pt[];
  const demo = config.mode === "synthetic_demo";
  const dark = useDarkTheme();
  const blank = dark ? "#251d2b" : "#f8f0e6";

  const routePts = legs.flatMap((f) => f.geometry.coordinates as Pt[]);
  const selected = legs.find((f) => f.properties.index === props.selectedLeg);
  const endpoints = [props.origin, props.destination]
    .filter((p): p is NamedPoint => !!p)
    .map((p) => [p.lon, p.lat] as Pt);
  const tripKey = endpoints.flat().join(",");
  const cover = useMemo(() => {
    // The fictional demo sits in open ocean; hide the base map under it.
    if (!demo || !service.length) return null;
    const lons = service.map((p) => p[0]);
    const lats = service.map((p) => p[1]);
    const [w, e, s, n] = [Math.min(...lons) - 1, Math.max(...lons) + 1, Math.min(...lats) - 1, Math.max(...lats) + 1];
    return [
      { lat: s, lng: w },
      { lat: s, lng: e },
      { lat: n, lng: e },
      { lat: n, lng: w },
    ];
  }, [demo, service]);
  const seatById = useMemo(() => {
    const all = new globalThis.Map<string, Seat>(props.seats.map((s) => [s.id, s]));
    for (const s of result?.stops ?? []) all.set(s.id, s);
    return all;
  }, [props.seats, result]);
  const popup = props.popup ? seatById.get(props.popup) : undefined;

  const visibleRestrooms = useMemo(() => {
    if (!props.showRestrooms) return [];
    const byId = new globalThis.Map<string, PublicRestroom>();
    for (const r of props.restrooms ?? []) byId.set(r.id, r);
    for (const r of result?.nearby_restrooms ?? []) byId.set(r.id, r);
    return Array.from(byId.values());
  }, [props.showRestrooms, props.restrooms, result]);
  const rrPopup = useMemo(
    () => (props.rrPopup ? visibleRestrooms.find((r) => r.id === props.rrPopup) : undefined),
    [props.rrPopup, visibleRestrooms],
  );

  if (status !== APILoadingStatus.LOADED) return null;
  return (
    <>
      <TestHook />
      <FitTo
        points={service}
        token={`mode-${config.mode}-${config.dataset_version}`}
        padding={props.padding}
      />
      <FitTo points={endpoints} token={`endpoints-${tripKey}`} padding={props.padding} />
      <FitTo
        points={routePts}
        token={`route-${result?.request_id}-${result?.total_distance_m}`}
        padding={props.padding}
      />
      <FitTo
        points={(selected?.geometry.coordinates as Pt[]) ?? []}
        token={`leg-${props.selectedLeg}`}
        padding={props.padding}
      />

      {cover && (
        <Polygon
          paths={[cover]}
          fillColor={blank}
          fillOpacity={1}
          strokeOpacity={0}
          clickable={false}
          zIndex={0}
        />
      )}
      {demo &&
        config.network_geojson?.features.map((f, i) => (
          <Polyline
            key={`net-${i}`}
            path={toPath(f.geometry.coordinates as Pt[])}
            strokeColor={dark ? "#4a3d52" : "#e2d2c2"}
            strokeWeight={9}
            strokeOpacity={0.9}
            clickable={false}
            zIndex={1}
          />
        ))}
      {service.length > 0 && (
        <Polyline
          path={toPath([...service, service[0]])}
          strokeOpacity={0}
          icons={dashes(dark ? "#c4b2c2" : COLORS.ink, "10px", 1.5)}
          clickable={false}
          zIndex={2}
        />
      )}

      {props.showComparison && hasRoute && result!.comparison_geojson?.features[0] && (
        <Polyline
          path={toPath(result!.comparison_geojson.features[0].geometry.coordinates as Pt[])}
          strokeOpacity={0}
          icons={dashes(COLORS.gray, "11px", 2)}
          clickable={false}
          zIndex={3}
        />
      )}
      {legs.map((f) => {
        const over = !!f.properties.over_limit;
        const isSel = f.properties.index === props.selectedLeg;
        const path = toPath(f.geometry.coordinates as Pt[]);
        const select = (e: google.maps.MapMouseEvent) => {
          // While picking a point, a tap on the route places it there.
          if (props.armed && e.latLng) props.onPick(e.latLng.lat(), e.latLng.lng());
          else props.onSelectLeg(isSel ? null : (f.properties.index as number));
        };
        const key = `${result!.request_id}-${f.properties.index}`;
        return [
          // A casing keeps the route readable over busy streets.
          <Polyline
            key={`case-${key}`}
            path={path}
            strokeColor={dark ? "#1c1622" : "#ffffff"}
            strokeWeight={isSel ? 14 : 10}
            strokeOpacity={0.95}
            zIndex={4}
            onClick={select}
          />,
          <Polyline
            key={`leg-${key}`}
            path={path}
            strokeColor={over ? COLORS.amber : COLORS.teal}
            strokeWeight={isSel ? 9 : 6}
            strokeOpacity={over ? 0 : 1}
            icons={over ? dashes(COLORS.amber, "14px", 4) : undefined}
            zIndex={5}
            onClick={select}
          />,
        ];
      })}

      {props.seats
        .filter((s) => !stopIds.has(s.id))
        .map((s) => {
          const userExcluded = props.excluded.includes(s.id);
          const eligible = s.routing_eligible && !userExcluded;
          return (
            <HtmlMarker
              key={s.id}
              lat={s.lat}
              lng={s.lon}
              title={s.label || s.type_label}
              zIndex={eligible ? 2 : 1}
              onClick={() => {
                props.setRrPopup(null);
                props.setPopup(s.id);
              }}
            >
              <div className={`seat-dot ${eligible ? "eligible" : "ineligible"}`} />
            </HtmlMarker>
          );
        })}

      {visibleRestrooms.map((rr) => (
        <HtmlMarker
          key={`rr-${rr.id}`}
          lat={rr.lat}
          lng={rr.lon}
          title={`Public restroom: ${rr.name} (${rr.status})`}
          zIndex={12}
          onClick={() => {
            props.setPopup(null);
            props.setRrPopup(rr.id);
          }}
        >
          <div
            className={`restroom-pin ${rr.operational ? "operational" : "closed"}`}
          >
            WC
          </div>
        </HtmlMarker>
      ))}

      {hasRoute &&
        result!.stops.map((s) => (
          <HtmlMarker
            key={`stop-${s.id}`}
            lat={s.lat}
            lng={s.lon}
            title={s.hypothetical ? `Stop ${s.number} (hypothetical bench)` : `Seat ${s.number}`}
            zIndex={20}
            onClick={() => {
              props.setRrPopup(null);
              props.setPopup(s.id);
            }}
          >
            <Pin text={String(s.number)} cls={s.hypothetical ? "stop hyp" : "stop"} />
          </HtmlMarker>
        ))}

      {props.hypothetical.map((h, i) => {
        const id = `@hyp${i + 1}`;
        if (stopIds.has(id)) return null;
        const snapped = result?.hypothetical?.benches.find((b) => b.id === id);
        return (
          <HtmlMarker
            key={`hyp-${i}`}
            lat={snapped ? snapped.lat : h.lat}
            lng={snapped ? snapped.lon : h.lon}
            title={`Hypothetical bench ${i + 1} (not a real seat)`}
            zIndex={15}
          >
            <Pin text={`H${i + 1}`} cls="hyp" />
          </HtmlMarker>
        );
      })}

      {result?.snapped_endpoints &&
        (["origin", "destination"] as const).map((k) => {
          const sp = result.snapped_endpoints![k];
          return (
            <HtmlMarker
              key={`snap-${k}`}
              lat={sp.snapped.lat}
              lng={sp.snapped.lon}
              title={`Attached to the walkway ${fmtM(sp.snap_distance_m)} from the ${k === "origin" ? "start" : "destination"} pin`}
              zIndex={25}
            >
              <div className="snap-dot" />
            </HtmlMarker>
          );
        })}
      {props.origin && (
        <HtmlMarker
          lat={props.origin.lat}
          lng={props.origin.lon}
          title={`Start: ${props.origin.name}`}
          zIndex={30}
        >
          <Pin text="A" cls="endpoint" />
        </HtmlMarker>
      )}
      {props.destination && (
        <HtmlMarker
          lat={props.destination.lat}
          lng={props.destination.lon}
          title={`Destination: ${props.destination.name}`}
          zIndex={30}
        >
          <Pin text="B" cls="endpoint destination" />
        </HtmlMarker>
      )}

      {popup && (
        <InfoWindow
          position={{ lat: popup.lat, lng: popup.lon }}
          pixelOffset={[0, -10]}
          onCloseClick={() => props.setPopup(null)}
          headerContent={<strong>{popup.label || popup.type_label}</strong>}
        >
          <div className="seat-popup">
            <p>{popup.type_label}</p>
            <p>
              {props.excluded.includes(popup.id)
                ? "Excluded by you for this trip"
                : stopIds.has(popup.id)
                  ? "A planned rest on this route"
                  : popup.routing_eligible
                    ? "Counted as a rest stop (on record)"
                    : `Not counted: ${popup.exclusion_reason}`}
            </p>
            {stopIds.has(popup.id) && !popup.id.startsWith("@hyp") && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  props.onExclude(popup.id);
                  props.setPopup(null);
                }}
              >
                Exclude this seat
              </button>
            )}
          </div>
        </InfoWindow>
      )}

      {rrPopup && (
        <InfoWindow
          position={{ lat: rrPopup.lat, lng: rrPopup.lon }}
          pixelOffset={[0, -10]}
          onCloseClick={() => props.setRrPopup(null)}
          headerContent={<strong>{rrPopup.name}</strong>}
        >
          <div className="seat-popup">
            <p>
              {rrPopup.location_type} · <strong>{rrPopup.status}</strong>
            </p>
            <p>ADA: {rrPopup.accessibility}</p>
            {rrPopup.hours && <p>Hours: {rrPopup.hours}</p>}
            {rrPopup.notes && <p>{rrPopup.notes}</p>}
          </div>
        </InfoWindow>
      )}
    </>
  );
}

/**
 * Google calls window.gm_authFailure when it refuses the key (for example on
 * an address the key is not allowed for). The map is then replaced by a
 * notice, so nothing keeps drawing on a map Google has disabled.
 */
function useGoogleAuthFailure() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const w = window as unknown as { gm_authFailure?: () => void };
    const previous = w.gm_authFailure;
    w.gm_authFailure = () => {
      setFailed(true);
      previous?.();
    };
    return () => {
      w.gm_authFailure = previous;
    };
  }, []);
  return failed;
}

export default function MapView(props: Props) {
  const { result } = props;
  const [popup, setPopup] = useState<string | null>(null);
  const [rrPopup, setRrPopup] = useState<string | null>(null);
  const authFailed = useGoogleAuthFailure();
  const dark = useDarkTheme();
  const region = props.config.region_bounds;
  const desktop = window.matchMedia?.("(min-width: 821px)").matches ?? false;
  const hasRoute =
    !!result && (result.status === "ok" || result.status === "limit_unmet");
  const legs = hasRoute ? (result!.route_geojson?.features ?? []) : [];

  const state = {
    "data-testid": "route-map",
    "data-legs": legs.length,
    "data-over-legs": legs.filter((f) => f.properties.over_limit).length,
    "data-stops": hasRoute ? result!.stops.length : 0,
  };
  const banner = props.armed && (
    <div className="map-banner" role="status">
      {props.armed === "bench"
        ? "Tap a mapped walkway to place a hypothetical bench."
        : `Tap a walking path to set your ${props.armed === "from" ? "start" : "destination"}.`}
      <button type="button" className="text-button" onClick={props.onCancelPick}>
        Cancel
      </button>
    </div>
  );

  if (!props.apiKey || authFailed)
    return (
      <div className="map-shell no-print" {...state}>
        <div className="map-missing" role="status" data-testid={authFailed ? "map-error" : undefined}>
          {authFailed
            ? "Google Maps didn’t accept this site’s map key, so the map can’t be shown. Your route is still listed in the panel."
            : "The map needs a Google Maps key on the server. Your route is still listed in the panel."}
        </div>
        {banner}
      </div>
    );

  return (
    <div className={`map-shell no-print ${props.armed ? "armed" : ""}`} {...state}>
      <MapErrorBoundary>
        <APIProvider apiKey={props.apiKey}>
          <Map
            className="gmap"
            defaultBounds={
              region
                ? { west: region[0], south: region[1], east: region[2], north: region[3], padding: 20 }
                : { west: -74.26, south: 40.47, east: -73.7, north: 40.92 }
            }
            styles={dark ? DARK_MAP : LIGHT_MAP}
            gestureHandling="greedy"
            disableDefaultUI
            zoomControl={desktop}
            clickableIcons={false}
            backgroundColor={dark ? "#1c1622" : "#f8f0e6"}
            onClick={(e) => {
              const ll = e.detail.latLng;
              if (props.armed && ll) props.onPick(ll.lat, ll.lng);
              else props.onMapTap();
              setPopup(null);
              setRrPopup(null);
            }}
          >
            <Overlays
              {...props}
              popup={popup}
              setPopup={setPopup}
              rrPopup={rrPopup}
              setRrPopup={setRrPopup}
            />
          </Map>
          <LoadProblem />
        </APIProvider>
      </MapErrorBoundary>
      {banner}
    </div>
  );
}
