export type Mode = "live_pilot" | "synthetic_demo" | "nearby";

export type RouteStatus =
  | "ok"
  | "limit_unmet"
  | "disconnected"
  | "unsupported_area"
  | "data_unavailable"
  | "endpoint_unresolved"
  | "error";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface NamedPoint extends LatLon {
  name: string;
}

export interface SourceRef {
  source: string;
  source_id: string;
  url: string | null;
  note?: string;
  imported_at?: string;
  source_updated_at?: string | null;
}

export interface Seat {
  id: string;
  lon: number;
  lat: number;
  type: string;
  type_label: string;
  label: string;
  source_refs: SourceRef[];
  public_access: string;
  backrest: boolean | null;
  armrests: boolean | null;
  covered: boolean | null;
  opening_hours: string | null;
  availability_status: string;
  imported_at: string | null;
  source_updated_at: string | null;
  last_field_verified_at: string | null;
  routing_eligible: boolean;
  exclusion_reason: string | null;
  attachment_metadata: Record<string, unknown> | null;
  seat_count: number;
}

export interface Stop extends Seat {
  number: number;
  hypothetical?: boolean;
}

export interface HypotheticalInfo {
  benches: {
    id: string;
    label: string;
    lat: number;
    lon: number;
    moved_m: number;
  }[];
  used: string[];
  without: {
    status: RouteStatus;
    total_distance_m: number;
    longest_gap_m: number;
    minimum_required_gap_m: number | null;
    rest_count: number;
  };
  note: string;
}

export interface ElevatorOutage {
  equipment_code: string;
  station?: string | null;
  trains?: string | null;
  serving?: string | null;
  outage_date?: string | null;
  estimated_return?: string | null;
  reason?: string | null;
  is_upcoming: boolean;
  is_maintenance: boolean;
}

export interface ElevatorReliability {
  period: string;
  months_recorded: number | null;
  availability_pct: number | null;
  total_outages: number | null;
  unscheduled_outages: number | null;
}

export interface StationElevator {
  equipment_code: string;
  description: string;
  street_access: boolean;
  ada_compliant: boolean;
  status: "in_service" | "outage";
  service_status: string;
  alternative_route?: string | null;
  active_outage?: ElevatorOutage | null;
  upcoming_outages?: ElevatorOutage[];
  reliability?: ElevatorReliability | null;
}

export interface StationElevatorAlert {
  endpoint: "start" | "destination";
  station_id: string;
  complex_id: string;
  station_name: string;
  routes: string;
  distance_m: number;
  lat: number;
  lon: number;
  ada_status: string;
  ada_notes?: string | null;
  elevator_count: number;
  active_outage_count: number;
  station_availability_pct?: number | null;
  station_total_outages_2026?: number | null;
  elevators: StationElevator[];
  outage_source: string;
  outage_updated_at?: string | null;
  source_url?: string | null;
}

export interface PublicRestroom {
  id: string;
  name: string;
  lat: number;
  lon: number;
  location_type: string;
  operator?: string | null;
  status: string;
  operational: boolean;
  open_season?: string | null;
  hours?: string | null;
  accessibility: string;
  restroom_type?: string | null;
  changing_stations?: string | null;
  notes?: string | null;
  website?: string | null;
  source_url?: string | null;
  retrieved_at?: string | null;
  distance_from_route_m?: number;
}

export interface Leg {
  index: number;
  from_id: string;
  to_id: string;
  from_label: string;
  to_label: string;
  distance_m: number;
  over_limit: boolean;
  exceeds_by_m: number;
}

export interface GeoJSONLine {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONLine[];
}

export interface SnapInfo {
  requested: LatLon;
  snapped: LatLon;
  snap_distance_m: number;
}

export interface RouteResponse {
  request_id: string;
  status: RouteStatus;
  message: string;
  dataset_version: string | null;
  data_mode: Mode;
  requested_max_gap_m: number;
  total_distance_m: number | null;
  longest_gap_m: number | null;
  minimum_required_gap_m: number | null;
  rest_count: number | null;
  extra_distance_m: number | null;
  comparison_distance_m: number | null;
  route_geojson: FeatureCollection | null;
  comparison_geojson: FeatureCollection | null;
  stops: Stop[];
  legs: Leg[];
  over_limit_legs: number[];
  warnings: string[];
  snapped_endpoints: { origin: SnapInfo; destination: SnapInfo } | null;
  limitation_note: string | null;
  timing_ms?: number | null;
  hypothetical?: HypotheticalInfo | null;
  station_elevators?: StationElevatorAlert[];
  nearby_restrooms?: PublicRestroom[];
}

export interface Trip {
  id: string;
  name: string;
  from: NamedPoint;
  to: NamedPoint;
  suggested_limits_m: number[];
}

export interface ModeConfig {
  mode: Mode;
  available: boolean;
  status?: string;
  reason?: string | null;
  dataset_version?: string;
  area_name?: string;
  service_polygon?: [number, number][];
  routing_polygon?: [number, number][];
  basemap_default?: boolean;
  trips?: Trip[];
  /** [minLon, minLat, maxLon, maxLat] of the area trips must stay inside. */
  region_bounds?: [number, number, number, number];
  counts?: Record<string, number>;
  retrieved?: Record<string, string>;
  sources?: { name: string; url: string | null; license?: string }[];
  network_geojson?: FeatureCollection;
}

export interface AppConfig {
  slider: { min_m: number; max_m: number; step_m: number; default_m: number };
  /** Browser key and map style id for the Google map (key is null when not configured). */
  google_maps?: { api_key: string | null };
  modes: Record<Mode, ModeConfig>;
  default_mode: Mode;
  limitation_note: string;
}

export interface Place extends LatLon {
  id: string;
  name: string;
  category: string | null;
  source: string;
  /** Set when the search result was moved from a building's center to the nearest walkway. */
  moved_to_walkway_m?: number;
}

export interface AreaResponse {
  status: "loading" | "ready" | "error" | "busy";
  dataset_id?: string;
  message: string;
  config?: ModeConfig;
  seats?: Seat[];
  restrooms?: PublicRestroom[];
}
