/// <reference types="google.maps" />
import { useEffect, useMemo, useState } from "react";
import {
  APILoadingStatus,
  APIProvider,
  AdvancedMarker,
  AdvancedMarkerAnchorPoint,
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
  RouteResponse,
  Seat,
} from "../types";
import { fmtM } from "../format";

const COLORS = {
  teal: "#0f766e",
  amber: "#b45309",
  gray: "#6b7280",
  ink: "#1f2421",
  net: "#a8b0ac",
  blank: "#eef1e8",
};

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Props {
  apiKey: string | null;
  mapId: string;
  config: ModeConfig;
  seats: Seat[];
  result: RouteResponse | null;
  origin: NamedPoint | null;
  destination: NamedPoint | null;
  armed: "from" | "to" | "bench" | null;
  hypothetical: LatLon[];
  onPick: (lat: number, lon: number) => void;
  onCancelPick: () => void;
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

function Pin({ text, cls }: { text: string; cls: string }) {
  return <div className={`map-pin ${cls}`}>{text}</div>;
}

export default function MapView(props: Props) {
  const { config, result } = props;
  const [openSeat, setOpenSeat] = useState<string | null>(null);
  const hasRoute =
    !!result && (result.status === "ok" || result.status === "limit_unmet");
  const legs = hasRoute ? (result!.route_geojson?.features ?? []) : [];
  const stopIds = new Set(hasRoute ? result!.stops.map((s) => s.id) : []);
  const service = (config.service_polygon ?? []) as Pt[];
  const region = config.region_bounds;
  const demo = config.mode === "synthetic_demo";
  const desktop = window.matchMedia?.("(min-width: 821px)").matches ?? false;

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
  const popup = openSeat ? seatById.get(openSeat) : undefined;

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

  if (!props.apiKey)
    return (
      <div className="map-shell no-print" {...state}>
        <div className="map-missing" role="status">
          The map needs a Google Maps key on the server. Your route is still
          listed in the panel.
        </div>
        {banner}
      </div>
    );

  return (
    <div className={`map-shell no-print ${props.armed ? "armed" : ""}`} {...state}>
      <APIProvider apiKey={props.apiKey}>
        <Map
          className="gmap"
          mapId={props.mapId}
          defaultBounds={
            region
              ? { west: region[0], south: region[1], east: region[2], north: region[3], padding: 20 }
              : { west: -74.26, south: 40.47, east: -73.7, north: 40.92 }
          }
          gestureHandling="greedy"
          disableDefaultUI
          zoomControl={desktop}
          clickableIcons={false}
          backgroundColor={COLORS.blank}
          onClick={(e) => {
            const ll = e.detail.latLng;
            if (props.armed && ll) props.onPick(ll.lat, ll.lng);
            setOpenSeat(null);
          }}
        >
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
              fillColor={COLORS.blank}
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
                strokeColor={COLORS.net}
                strokeWeight={9}
                strokeOpacity={0.55}
                clickable={false}
                zIndex={1}
              />
            ))}
          {service.length > 0 && (
            <Polyline
              path={toPath([...service, service[0]])}
              strokeOpacity={0}
              icons={dashes(COLORS.ink, "10px", 1.5)}
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
              // A white casing keeps the route readable over busy streets.
              <Polyline
                key={`case-${key}`}
                path={path}
                strokeColor="#ffffff"
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
                <AdvancedMarker
                  key={s.id}
                  position={{ lat: s.lat, lng: s.lon }}
                  anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
                  title={s.label || s.type_label}
                  zIndex={eligible ? 2 : 1}
                  onClick={() => setOpenSeat(s.id)}
                >
                  <div className={`seat-dot ${eligible ? "eligible" : "ineligible"}`} />
                </AdvancedMarker>
              );
            })}

          {hasRoute &&
            result!.stops.map((s) => (
              <AdvancedMarker
                key={`stop-${s.id}`}
                position={{ lat: s.lat, lng: s.lon }}
                anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
                title={s.hypothetical ? `Stop ${s.number} (hypothetical bench)` : `Seat ${s.number}`}
                zIndex={20}
                onClick={() => setOpenSeat(s.id)}
              >
                <Pin text={String(s.number)} cls={s.hypothetical ? "stop hyp" : "stop"} />
              </AdvancedMarker>
            ))}

          {props.hypothetical.map((h, i) => {
            const id = `@hyp${i + 1}`;
            if (stopIds.has(id)) return null;
            const snapped = result?.hypothetical?.benches.find((b) => b.id === id);
            return (
              <AdvancedMarker
                key={`hyp-${i}`}
                position={snapped ? { lat: snapped.lat, lng: snapped.lon } : { lat: h.lat, lng: h.lon }}
                anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
                title={`Hypothetical bench ${i + 1} (not a real seat)`}
                zIndex={15}
              >
                <Pin text={`H${i + 1}`} cls="hyp" />
              </AdvancedMarker>
            );
          })}

          {result?.snapped_endpoints &&
            (["origin", "destination"] as const).map((k) => {
              const sp = result.snapped_endpoints![k];
              return (
                <AdvancedMarker
                  key={`snap-${k}`}
                  position={{ lat: sp.snapped.lat, lng: sp.snapped.lon }}
                  anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
                  title={`Attached to the walkway ${fmtM(sp.snap_distance_m)} from the ${k === "origin" ? "start" : "destination"} pin`}
                  zIndex={25}
                >
                  <div className="snap-dot" />
                </AdvancedMarker>
              );
            })}
          {props.origin && (
            <AdvancedMarker
              position={{ lat: props.origin.lat, lng: props.origin.lon }}
              title={`Start: ${props.origin.name}`}
              zIndex={30}
            >
              <Pin text="A" cls="endpoint" />
            </AdvancedMarker>
          )}
          {props.destination && (
            <AdvancedMarker
              position={{ lat: props.destination.lat, lng: props.destination.lon }}
              title={`Destination: ${props.destination.name}`}
              zIndex={30}
            >
              <Pin text="B" cls="endpoint destination" />
            </AdvancedMarker>
          )}

          {popup && (
            <InfoWindow
              position={{ lat: popup.lat, lng: popup.lon }}
              pixelOffset={[0, -10]}
              onCloseClick={() => setOpenSeat(null)}
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
                      setOpenSeat(null);
                    }}
                  >
                    Exclude this seat
                  </button>
                )}
              </div>
            </InfoWindow>
          )}
        </Map>
        <LoadProblem />
      </APIProvider>
      {banner}
    </div>
  );
}
