import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import type { LatLon, ModeConfig, NamedPoint, RouteResponse, Seat } from '../types';
import { fmtM } from '../format';

const TILE_URL = (import.meta.env.VITE_TILE_URL as string | undefined) ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  (import.meta.env.VITE_TILE_ATTRIBUTION as string | undefined) ??
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const COLORS = { teal: '#0f766e', amber: '#b45309', gray: '#6b7280', ink: '#1f2421', net: '#a8b0ac' };

function labelIcon(text: string, cls: string) {
  return L.divIcon({ className: '', html: `<div class="map-pin ${cls}">${text}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
}

function toLatLngs(coords: [number, number][]): LatLngExpression[] {
  return coords.map(([lon, lat]) => [lat, lon] as LatLngExpression);
}

function boundsOf(points: [number, number][]): LatLngBoundsExpression | null {
  if (!points.length) return null;
  const lats = points.map((p) => p[1]);
  const lons = points.map((p) => p[0]);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

function ClickHandler({ armed, onPick }: { armed: boolean; onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      if (armed) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitTo({ bounds, token }: { bounds: LatLngBoundsExpression | null; token: string }) {
  const map = useMap();
  useEffect(() => {
    // No animation: an animated zoom that is still running when the map is
    // replaced (switching data sets) makes Leaflet throw.
    if (bounds) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 18, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return null;
}

interface Props {
  config: ModeConfig;
  basemap: boolean;
  seats: Seat[];
  result: RouteResponse | null;
  origin: NamedPoint | null;
  destination: NamedPoint | null;
  armed: 'from' | 'to' | 'bench' | null;
  hypothetical: LatLon[];
  onPick: (lat: number, lon: number) => void;
  selectedLeg: number | null;
  onSelectLeg: (i: number | null) => void;
  showComparison: boolean;
  excluded: string[];
  onExclude: (id: string) => void;
}

export default function RouteMap(props: Props) {
  const { config, result } = props;
  const [tileError, setTileError] = useState(false);
  const service = config.service_polygon ?? [];
  const serviceBounds = useMemo(() => boundsOf(service), [service]);
  const hasRoute = !!result && (result.status === 'ok' || result.status === 'limit_unmet');
  const legs = hasRoute ? (result!.route_geojson?.features ?? []) : [];
  const allRoutePts = legs.flatMap((f) => f.geometry.coordinates);
  const selected = legs.find((f) => f.properties.index === props.selectedLeg);
  const fitBounds = selected ? boundsOf(selected.geometry.coordinates) : null;
  const tripKey = `${props.origin?.lat},${props.origin?.lon},${props.destination?.lat},${props.destination?.lon}`;
  const routeBounds = useMemo(() => boundsOf(allRoutePts), [tripKey, hasRoute]); // eslint-disable-line react-hooks/exhaustive-deps
  const stopIds = new Set(hasRoute ? result!.stops.map((s) => s.id) : []);

  useEffect(() => setTileError(false), [props.basemap]);

  return (
    <div className="map-wrap" role="region" aria-label="Map. The same route is listed as text in the itinerary.">
      {props.armed && (
        <div className="map-banner" role="status">
          {props.armed === 'bench'
            ? 'Tap a mapped walkway to place a hypothetical bench.'
            : `Tap the map to set the ${props.armed === 'from' ? 'start' : 'destination'}.`}
        </div>
      )}
      {tileError && (
        <div className="map-banner warn" role="status" data-testid="tile-error">
          Map tiles failed to load. The route lines and the text itinerary still work.
        </div>
      )}
      <MapContainer
        key={config.mode}
        className={`map ${props.armed ? 'armed' : ''}`}
        bounds={serviceBounds ?? [[0, 0], [0.01, 0.01]]}
        zoomControl
        scrollWheelZoom
        attributionControl
      >
        {props.basemap && (
          <TileLayer
            url={TILE_URL}
            attribution={TILE_ATTRIBUTION}
            maxZoom={19}
            eventHandlers={{ tileerror: () => setTileError(true) }}
          />
        )}
        {!props.basemap && config.network_geojson && (
          <GeoJSON
            key={`net-${config.dataset_version}`}
            data={config.network_geojson as unknown as GeoJSON.GeoJsonObject}
            style={() => ({ color: COLORS.net, weight: 9, opacity: 0.55, lineCap: 'round' })}
            interactive={false}
          />
        )}
        {service.length > 0 && (
          <Polygon
            positions={toLatLngs(service)}
            pathOptions={{ color: COLORS.ink, weight: 1.5, dashArray: '6 6', fill: false }}
            interactive={false}
          />
        )}
        <ClickHandler armed={!!props.armed} onPick={props.onPick} />
        <FitTo bounds={serviceBounds} token={`mode-${config.mode}`} />
        <FitTo bounds={routeBounds} token={`route-${tripKey}-${hasRoute}`} />
        <FitTo bounds={fitBounds} token={`leg-${props.selectedLeg}`} />

        {props.showComparison && hasRoute && result!.comparison_geojson?.features[0] && (
          <Polyline
            positions={toLatLngs(result!.comparison_geojson.features[0].geometry.coordinates)}
            pathOptions={{ color: COLORS.gray, weight: 4, dashArray: '2 9', lineCap: 'round' }}
            className="comparison-route"
          >
            <Tooltip sticky>Shortest walk (no rest rule): {fmtM(result!.comparison_distance_m)}</Tooltip>
          </Polyline>
        )}

        {legs.map((f) => {
          const over = !!f.properties.over_limit;
          const isSel = f.properties.index === props.selectedLeg;
          return (
            <Polyline
              key={`leg-${result!.request_id}-${f.properties.index}`}
              positions={toLatLngs(f.geometry.coordinates)}
              pathOptions={{
                color: over ? COLORS.amber : COLORS.teal,
                weight: isSel ? 9 : 6,
                dashArray: over ? '12 8' : undefined,
                opacity: 0.95,
                lineCap: 'round',
              }}
              className={over ? 'route-leg over' : 'route-leg'}
              eventHandlers={{ click: () => props.onSelectLeg(isSel ? null : (f.properties.index as number)) }}
            >
              <Tooltip sticky>
                Leg {String(f.properties.index)}: {String(f.properties.from_label)} → {String(f.properties.to_label)},{' '}
                {fmtM(f.properties.distance_m as number)}
                {over ? ' (over your limit)' : ''}
              </Tooltip>
            </Polyline>
          );
        })}

        {props.seats
          .filter((s) => !stopIds.has(s.id))
          .map((s) => {
            const userExcluded = props.excluded.includes(s.id);
            const eligible = s.routing_eligible && !userExcluded;
            return (
              <CircleMarker
                key={s.id}
                center={[s.lat, s.lon]}
                radius={eligible ? 6 : 4}
                pathOptions={{
                  color: eligible ? COLORS.teal : COLORS.gray,
                  weight: 2,
                  fillColor: eligible ? '#ffffff' : '#e5e7eb',
                  fillOpacity: 1,
                  dashArray: eligible ? undefined : '2 2',
                }}
              >
                <Popup>
                  <strong>{s.label || s.type_label}</strong>
                  <br />
                  {s.type_label}
                  <br />
                  {userExcluded
                    ? 'Excluded by you for this trip'
                    : s.routing_eligible
                      ? 'Counted as a rest stop (on record)'
                      : `Not counted: ${s.exclusion_reason}`}
                </Popup>
              </CircleMarker>
            );
          })}

        {hasRoute &&
          result!.stops.map((s) => (
            <Marker
              key={`stop-${s.id}`}
              position={[s.lat, s.lon]}
              icon={labelIcon(String(s.number), s.hypothetical ? 'stop hyp' : 'stop')}
            >
              <Popup>
                <strong>
                  {s.hypothetical ? `Stop ${s.number}: ${s.label} (not a real seat)` : `Seat ${s.number}: ${s.label || s.type_label}`}
                </strong>
                {!s.hypothetical && (
                  <>
                    <br />
                    <button type="button" className="btn small" onClick={() => props.onExclude(s.id)}>
                      Exclude this seat
                    </button>
                  </>
                )}
              </Popup>
            </Marker>
          ))}

        {props.hypothetical.map((h, i) => {
          const snapped = result?.hypothetical?.benches.find((b) => b.id === `@hyp${i + 1}`);
          if (stopIds.has(`@hyp${i + 1}`)) return null;
          return (
            <Marker
              key={`hyp-${i}`}
              position={snapped ? [snapped.lat, snapped.lon] : [h.lat, h.lon]}
              icon={labelIcon(`H${i + 1}`, 'hyp')}
            >
              <Tooltip>Hypothetical bench {i + 1} (not a real seat)</Tooltip>
            </Marker>
          );
        })}

        {props.origin && (
          <Marker position={[props.origin.lat, props.origin.lon]} icon={labelIcon('A', 'endpoint')}>
            <Tooltip>Start: {props.origin.name}</Tooltip>
          </Marker>
        )}
        {props.destination && (
          <Marker position={[props.destination.lat, props.destination.lon]} icon={labelIcon('B', 'endpoint')}>
            <Tooltip>Destination: {props.destination.name}</Tooltip>
          </Marker>
        )}
        {result?.snapped_endpoints &&
          (['origin', 'destination'] as const).map((k) => {
            const sp = result.snapped_endpoints![k];
            return (
              <CircleMarker
                key={`snap-${k}`}
                center={[sp.snapped.lat, sp.snapped.lon]}
                radius={3}
                pathOptions={{ color: COLORS.ink, weight: 1, fillColor: COLORS.ink, fillOpacity: 1 }}
              >
                <Tooltip>
                  Attached to the walkway {fmtM(sp.snap_distance_m)} from the {k === 'origin' ? 'start' : 'destination'} pin
                </Tooltip>
              </CircleMarker>
            );
          })}
      </MapContainer>
      <div className="map-legend" aria-hidden="true">
        <span>
          <i className="sw teal" /> within limit
        </span>
        <span>
          <i className="sw amber" /> over limit (dashed)
        </span>
        {props.showComparison && (
          <span>
            <i className="sw gray" /> shortest walk (dotted)
          </span>
        )}
        <span>
          <i className="dot eligible" /> seat on record
        </span>
        <span>
          <i className="dot ineligible" /> not counted
        </span>
      </div>
    </div>
  );
}
