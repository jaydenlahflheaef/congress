import type { AppConfig, LatLon, Mode, Place, RouteResponse, Seat } from '../types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, { signal });
  if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
  return (await res.json()) as T;
}

export function fetchConfig(signal?: AbortSignal) {
  return getJson<AppConfig>('/api/config', signal);
}

export function fetchSeats(mode: Mode, bbox: [number, number, number, number], signal?: AbortSignal) {
  const q = new URLSearchParams({ bbox: bbox.join(','), mode, include_ineligible: 'true' });
  return getJson<{ status: string; seats: Seat[]; message?: string }>(`/api/seats?${q}`, signal);
}

export function searchPlaces(mode: Mode, q: string, signal?: AbortSignal) {
  const p = new URLSearchParams({ q, mode });
  return getJson<{ status: string; places: Place[] }>(`/api/places?${p}`, signal);
}

export interface RouteRequestBody {
  origin: LatLon;
  destination: LatLon;
  max_gap_m: number;
  excluded_seat_ids: string[];
  dataset_mode: Mode;
  client_request_id?: string;
  hypothetical_seats?: LatLon[];
}

export async function fetchRoute(body: RouteRequestBody, signal?: AbortSignal): Promise<RouteResponse> {
  const res = await fetch(BASE + '/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 500) {
    // The backend sends a structured "error" status; show it as an error.
    return (await res.json()) as RouteResponse;
  }
  if (!res.ok) throw new ApiError(`Route request failed (${res.status})`, res.status);
  return (await res.json()) as RouteResponse;
}
