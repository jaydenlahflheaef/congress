/// <reference types="google.maps" />
import {
  Component,
  type CSSProperties,
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
import { toMapFrame, turnToHeading } from "../geometry";

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
  focusedRestroomId?: string | null;
  onFocusRestroom?: (id: string | null) => void;
  /** Where the phone is (only while tracking), and which way it faces. */
  you?: { lat: number; lon: number; accuracy: number } | null;
  heading?: number | null;
  /** Walking: lock the camera on you and turn the map to face your direction. */
  follow?: boolean;
  /** Changes whenever the Locate button is pressed, to re-center once. */
  centerToken?: number;
  /** The person moved or turned the map by hand, so following should pause. */
  onUserMoved?: () => void;
  walkingLeg?: number | null;
  onStartWalkLeg?: (index: number | null) => void;
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

/** Hands the live map object to code outside the <Map> element (touch gestures). */
function MapRef({ target }: { target: { current: google.maps.Map | null } }) {
  const map = useMap();
  useEffect(() => {
    target.current = map;
    return () => {
      target.current = null;
    };
  }, [map, target]);
  return null;
}

/** Move the map's center by a pixel offset (in the map element's own, unrotated frame). */
function shiftCenter(map: google.maps.Map, dx: number, dy: number) {
  const proj = map.getProjection();
  const center = map.getCenter();
  const zoom = map.getZoom();
  if (!proj || !center || zoom === undefined) return;
  const p = proj.fromLatLngToPoint(center)!;
  const scale = 2 ** zoom;
  const next = proj.fromPointToLatLng(new google.maps.Point(p.x + dx / scale, p.y + dy / scale));
  if (next) map.setCenter(next);
}

/** Keeps you in view: re-centers when asked, and follows you while walking. */
function CameraControl({
  you,
  follow,
  centerToken,
  padding,
  rotationDeg,
  lower,
}: {
  you: { lat: number; lon: number } | null;
  follow: boolean;
  centerToken: number;
  padding: MapPadding;
  rotationDeg: number;
  lower: number;
}) {
  const map = useMap();
  const lastToken = useRef(centerToken);
  const wasFollowing = useRef(false);
  const rot = useRef(rotationDeg);
  rot.current = rotationDeg;
  useEffect(() => {
    if (!map || !you) return;
    const recenter = centerToken !== lastToken.current;
    lastToken.current = centerToken;
    const startedFollowing = follow && !wasFollowing.current;
    wasFollowing.current = follow;
    if (!follow && !recenter) return;
    if (recenter || startedFollowing) {
      const minZoom = follow ? 18 : 17;
      if ((map.getZoom() ?? 0) < minZoom) map.setZoom(minZoom);
    }
    // Put you in the middle of the visible part of the map, a little low while
    // walking so there is more room to see what is ahead.
    const down = (padding.top - padding.bottom) / 2 + (follow ? lower : 0);
    const c = toMapFrame(0, down, rot.current);
    const proj = map.getProjection();
    const zoom = map.getZoom();
    if (!proj || zoom === undefined) {
      map.panTo({ lat: you.lat, lng: you.lon });
      return;
    }
    const p = proj.fromLatLngToPoint(new google.maps.LatLng(you.lat, you.lon))!;
    const scale = 2 ** zoom;
    const target = proj.fromPointToLatLng(new google.maps.Point(p.x - c.x / scale, p.y - c.y / scale));
    if (target) map.panTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, you?.lat, you?.lon, follow, centerToken]);
  return null;
}

/** The blue "you are here" dot, with an accuracy halo and a beam toward where you face. */
function YouMarker({
  you,
  heading,
}: {
  you: { lat: number; lon: number; accuracy: number };
  heading: number | null;
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map?.getZoom() ?? 17);
  useEffect(() => {
    if (!map) return;
    setZoom(map.getZoom() ?? 17);
    const l = map.addListener("zoom_changed", () => setZoom(map.getZoom() ?? 17));
    return () => l.remove();
  }, [map]);
  const metersPerPx = (156543.03392 * Math.cos((you.lat * Math.PI) / 180)) / 2 ** zoom;
  const radius = Math.min(160, you.accuracy / metersPerPx);
  return (
    <HtmlMarker lat={you.lat} lng={you.lon} title="You are here" zIndex={40}>
      <div className="you" data-testid="you-are-here" data-heading={heading === null ? "" : Math.round(heading)}>
        {radius > 14 && <div className="you-halo" style={{ width: radius * 2, height: radius * 2 }} />}
        {heading !== null && <div className="you-cone" style={{ transform: `rotate(${heading}deg)` }} />}
        <div className="you-dot" />
      </div>
    </HtmlMarker>
  );
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
  const activeLegIndex = props.walkingLeg ?? props.selectedLeg;
  const selected = legs.find((f) => f.properties.index === activeLegIndex);
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
    if (!props.showRestrooms && !props.focusedRestroomId) return [];
    const byId = new globalThis.Map<string, PublicRestroom>();
    for (const r of props.restrooms ?? []) byId.set(r.id, r);
    for (const r of result?.nearby_restrooms ?? []) byId.set(r.id, r);
    return Array.from(byId.values());
  }, [props.showRestrooms, props.focusedRestroomId, props.restrooms, result]);

  const activeRrId = props.rrPopup ?? props.focusedRestroomId ?? null;
  const rrPopup = useMemo(
    () => (activeRrId ? visibleRestrooms.find((r) => r.id === activeRrId) : undefined),
    [activeRrId, visibleRestrooms],
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
        token={`leg-${activeLegIndex}`}
        padding={props.padding}
      />
      {rrPopup && (
        <FitTo
          points={[[rrPopup.lon, rrPopup.lat]]}
          token={`rr-${rrPopup.id}`}
          padding={props.padding}
        />
      )}

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
        const isSel = f.properties.index === activeLegIndex;
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
                props.onFocusRestroom?.(null);
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
              props.onFocusRestroom?.(null);
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
      {props.you && <YouMarker you={props.you} heading={props.heading ?? null} />}

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
          onCloseClick={() => {
            props.setRrPopup(null);
            props.onFocusRestroom?.(null);
          }}
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
  const [rotationDeg, setRotationDeg] = useState(0);
  const mapRef = useRef<google.maps.Map | null>(null);
  // Phones: EzWay handles drag, pinch and twist itself, so they stay correct
  // when the map is turned. Computers keep Google's own mouse controls.
  const touchDevice = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches ?? false, []);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // The map layer is a square as wide as the screen diagonal, centered on the
  // screen, so turning it never shows an edge or stretches the tiles.
  const side = touchDevice ? Math.ceil(Math.hypot(size.w, size.h)) : 0;
  const offX = touchDevice ? (side - size.w) / 2 : 0;
  const offY = touchDevice ? (side - size.h) / 2 : 0;
  const gesture = useRef<{
    kind: "pan" | "pinch";
    x: number;
    y: number;
    dist: number;
    angle: number;
    baseRot: number;
    baseZoom: number;
    moved: boolean;
  } | null>(null);
  const userMoved = () => props.onUserMoved?.();

  // While walking, turn the map so the direction you face is up.
  useEffect(() => {
    if (props.armed) {
      setRotationDeg(0);
      return;
    }
    if (!props.follow || props.heading == null) return;
    setRotationDeg((prev) => {
      const next = turnToHeading(prev, props.heading!);
      return Math.abs(next - prev) < 1.5 ? prev : next;
    });
  }, [props.follow, props.heading, props.armed]);
  useEffect(() => {
    if (props.walkingLeg == null) setRotationDeg(0);
  }, [props.walkingLeg]);
  const authFailed = useGoogleAuthFailure();
  const dark = useDarkTheme();
  const region = props.config.region_bounds;
  const desktop = window.matchMedia?.("(min-width: 821px)").matches ?? false;
  const hasRoute =
    !!result && (result.status === "ok" || result.status === "limit_unmet");
  const legs = hasRoute ? (result!.route_geojson?.features ?? []) : [];

  const activeWalkLeg =
    hasRoute && props.walkingLeg != null
      ? result!.legs.find((l) => l.index === props.walkingLeg) ?? null
      : null;

  const state = {
    "data-testid": "route-map",
    "data-legs": legs.length,
    "data-over-legs": legs.filter((f) => f.properties.over_limit).length,
    "data-stops": hasRoute ? result!.stops.length : 0,
    "data-rotation": Math.round(rotationDeg),
  };

  const banner = props.armed ? (
    <div className="map-banner" role="status">
      {props.armed === "bench"
        ? "Tap a mapped walkway to place a hypothetical bench."
        : `Tap a walking path to set your ${props.armed === "from" ? "start" : "destination"}.`}
      <button type="button" className="text-button" onClick={props.onCancelPick}>
        Cancel
      </button>
    </div>
  ) : activeWalkLeg ? (
    <div className="map-banner walk-banner" role="status" data-testid="walk-guidance-banner">
      <div className="walk-banner-info">
        <span className="walk-step-label">
          Step {activeWalkLeg.index} of {result!.legs.length}
        </span>
        <strong>
          {activeWalkLeg.from_label} → {activeWalkLeg.to_label} (
          {fmtM(activeWalkLeg.distance_m)})
        </strong>
      </div>
      <div className="walk-banner-actions">
        <button
          type="button"
          className="btn small"
          disabled={activeWalkLeg.index <= 1}
          onClick={() => props.onStartWalkLeg?.(activeWalkLeg.index - 1)}
        >
          Prev
        </button>
        {activeWalkLeg.index < result!.legs.length ? (
          <button
            type="button"
            className="btn small"
            onClick={() => props.onStartWalkLeg?.(activeWalkLeg.index + 1)}
          >
            Next stop
          </button>
        ) : (
          <button
            type="button"
            className="btn small"
            onClick={() => props.onStartWalkLeg?.(null)}
          >
            Done
          </button>
        )}
        <button
          type="button"
          className="text-button"
          onClick={() => props.onStartWalkLeg?.(null)}
        >
          End walk
        </button>
      </div>
    </div>
  ) : null;

  const fingers = (t: React.TouchList) => {
    const dx = t[1].clientX - t[0].clientX;
    const dy = t[1].clientY - t[0].clientY;
    return { dist: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (!touchDevice || props.armed) return;
    const map = mapRef.current;
    if (e.touches.length === 1) {
      gesture.current = { kind: "pan", x: e.touches[0].clientX, y: e.touches[0].clientY, dist: 0, angle: 0, baseRot: rotationDeg, baseZoom: map?.getZoom() ?? 0, moved: false };
    } else if (e.touches.length === 2) {
      const f = fingers(e.touches);
      gesture.current = { kind: "pinch", x: 0, y: 0, dist: f.dist, angle: f.angle, baseRot: rotationDeg, baseZoom: map?.getZoom() ?? 0, moved: false };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    const map = mapRef.current;
    if (!g || !map || !touchDevice) return;
    if (g.kind === "pan" && e.touches.length === 1) {
      const dx = e.touches[0].clientX - g.x;
      const dy = e.touches[0].clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      if (!g.moved) userMoved();
      g.moved = true;
      g.x = e.touches[0].clientX;
      g.y = e.touches[0].clientY;
      // Dragging the map moves its center the opposite way, in the turned frame.
      const c = toMapFrame(dx, dy, rotationDeg);
      shiftCenter(map, -c.x, -c.y);
    } else if (g.kind === "pinch" && e.touches.length === 2) {
      const f = fingers(e.touches);
      const turn = f.angle - g.angle;
      const steps = Math.round(Math.log2(f.dist / g.dist));
      if (!g.moved && (Math.abs(turn) > 4 || steps !== 0)) {
        g.moved = true;
        userMoved();
      }
      if (!g.moved) return;
      setRotationDeg(((((g.baseRot + turn + 180) % 360) + 360) % 360) - 180);
      if (g.baseZoom + steps !== map.getZoom()) map.setZoom(g.baseZoom + steps);
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) gesture.current = null;
    else if (e.touches.length === 1 && gesture.current?.kind === "pinch") {
      // One finger stayed down after a pinch: carry on as a drag from here.
      const map = mapRef.current;
      gesture.current = { kind: "pan", x: e.touches[0].clientX, y: e.touches[0].clientY, dist: 0, angle: 0, baseRot: rotationDeg, baseZoom: map?.getZoom() ?? 0, moved: true };
    }
  };

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

  const isRotated = Math.abs(rotationDeg) > 1;

  return (
    <div
      className={`map-shell no-print ${props.armed ? "armed" : ""}`}
      {...state}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <MapErrorBoundary>
        <div
          className={`map-rotator ${props.follow ? "turning" : ""}`}
          style={
            {
              ...(touchDevice
                ? { position: "absolute", width: side, height: side, left: -offX, top: -offY }
                : null),
              transform: isRotated ? `rotate(${rotationDeg}deg)` : undefined,
              "--map-rot": `${isRotated ? rotationDeg : 0}deg`,
            } as CSSProperties
          }
        >
          <APIProvider apiKey={props.apiKey}>
            <Map
              className="gmap"
              defaultBounds={
                region
                  ? { west: region[0], south: region[1], east: region[2], north: region[3], padding: 20 }
                  : { west: -74.26, south: 40.47, east: -73.7, north: 40.92 }
              }
              styles={dark ? DARK_MAP : LIGHT_MAP}
              gestureHandling={touchDevice ? "none" : "greedy"}
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
                props.onFocusRestroom?.(null);
              }}
            >
              <MapRef target={mapRef} />
              <CameraControl
                you={props.you ?? null}
                follow={!!props.follow}
                centerToken={props.centerToken ?? 0}
                padding={props.padding}
                rotationDeg={rotationDeg}
                lower={size.h * 0.08}
              />
              <Overlays
                {...props}
                padding={
                  touchDevice
                    ? {
                        top: props.padding.top + offY,
                        bottom: props.padding.bottom + offY,
                        left: props.padding.left + offX,
                        right: props.padding.right + offX,
                      }
                    : props.padding
                }
                popup={popup}
                setPopup={setPopup}
                rrPopup={rrPopup}
                setRrPopup={setRrPopup}
              />
            </Map>
            <LoadProblem />
          </APIProvider>
        </div>
      </MapErrorBoundary>
      {isRotated && (
        <button
          type="button"
          className="compass-reset"
          aria-label="Reset map rotation to north"
          title="Reset map rotation to north"
          onClick={() => setRotationDeg(0)}
        >
          <span
            className="compass-needle"
            style={{ transform: `rotate(${rotationDeg}deg)` }}
            aria-hidden="true"
          >
            ▲
          </span>
          <span>N</span>
        </button>
      )}
      {banner}
    </div>
  );
}
