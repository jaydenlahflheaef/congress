import type { AppConfig, RouteResponse, Stop } from "../types";

export const config: AppConfig = {
  slider: { min_m: 50, max_m: 500, step_m: 10, default_m: 150 },
  default_mode: "nearby",
  limitation_note: "Seat records can be incomplete or outdated.",
  modes: {
    nearby: {
      mode: "nearby",
      available: true,
      basemap_default: true,
      area_name: "New York City",
      region_bounds: [-74.26, 40.47, -73.7, 40.92],
      trips: [
        {
          id: "main-st-to-library",
          name: "Flushing–Main St station to Queens Public Library at Flushing",
          from: { name: "Flushing–Main St station (7 train)", lat: 40.7597, lon: -73.8296 },
          to: { name: "Queens Public Library at Flushing", lat: 40.7578, lon: -73.8289 },
          suggested_limits_m: [400, 150, 100],
        },
      ],
    },
    live_pilot: {
      mode: "live_pilot",
      available: false,
      status: "data_unavailable",
      reason: "Not imported yet.",
    },
    synthetic_demo: {
      mode: "synthetic_demo",
      available: true,
      dataset_version: "synthetic-test",
      area_name: "Test town",
      service_polygon: [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [0, 0],
      ],
      routing_polygon: [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [0, 0],
      ],
      basemap_default: false,
      trips: [
        {
          id: "demo",
          name: "Demo trip",
          from: { name: "Start Place", lat: 0.001, lon: 0.001 },
          to: { name: "End Place", lat: 0.002, lon: 0.002 },
          suggested_limits_m: [150],
        },
      ],
    },
  },
};

export function stop(id: string, number: number): Stop {
  return {
    id,
    number,
    lon: 0.001,
    lat: 0.001,
    type: "bench",
    type_label: "Bench",
    label: `Bench ${id}`,
    source_refs: [{ source: "synthetic", source_id: id, url: null }],
    public_access: "yes",
    backrest: true,
    armrests: null,
    covered: null,
    opening_hours: null,
    availability_status: "on_record",
    imported_at: "2026-10-26T00:00:00Z",
    source_updated_at: null,
    last_field_verified_at: null,
    routing_eligible: true,
    exclusion_reason: null,
    attachment_metadata: null,
    seat_count: 1,
  };
}

export function okRoute(
  limit: number,
  stopIds: string[] = ["s1", "s2"],
  total = 300,
): RouteResponse {
  const ids = ["@origin", ...stopIds, "@destination"];
  const labels = [
    "Start",
    ...stopIds.map((_, i) => `Seat ${i + 1}`),
    "Destination",
  ];
  const legs = ids.slice(1).map((to, i) => ({
    index: i + 1,
    from_id: ids[i],
    to_id: to,
    from_label: labels[i],
    to_label: labels[i + 1],
    distance_m: total / (ids.length - 1),
    over_limit: false,
    exceeds_by_m: 0,
  }));
  return {
    request_id: "x",
    status: "ok",
    message: `Every leg is ${limit} m or less. Based on recorded seating and mapped paths.`,
    dataset_version: "synthetic-test",
    data_mode: "synthetic_demo",
    requested_max_gap_m: limit,
    total_distance_m: total,
    longest_gap_m: total / (ids.length - 1),
    minimum_required_gap_m: null,
    rest_count: stopIds.length,
    extra_distance_m: 12,
    comparison_distance_m: total - 12,
    route_geojson: { type: "FeatureCollection", features: [] },
    comparison_geojson: { type: "FeatureCollection", features: [] },
    stops: stopIds.map((id, i) => stop(id, i + 1)),
    legs,
    over_limit_legs: [],
    warnings: [],
    snapped_endpoints: null,
    limitation_note: "Seat records can be incomplete or outdated.",
  };
}

export function unmetRoute(limit: number): RouteResponse {
  const r = okRoute(limit, ["s1"], 272);
  return {
    ...r,
    status: "limit_unmet",
    message: `No route within ${limit} m found in this mapped area. The smallest achievable longest gap is 136 m.`,
    minimum_required_gap_m: 136,
    longest_gap_m: 136,
    legs: r.legs.map((l) => ({
      ...l,
      over_limit: true,
      exceeds_by_m: 136 - limit,
    })),
    over_limit_legs: [1, 2],
  };
}

export function failure(
  status: RouteResponse["status"],
  message: string,
): RouteResponse {
  return {
    ...okRoute(150),
    status,
    message,
    total_distance_m: null,
    longest_gap_m: null,
    rest_count: null,
    extra_distance_m: null,
    comparison_distance_m: null,
    route_geojson: null,
    comparison_geojson: null,
    stops: [],
    legs: [],
  };
}
