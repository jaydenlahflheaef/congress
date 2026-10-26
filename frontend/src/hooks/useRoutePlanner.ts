import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRoute } from '../api/client';
import { createLatestOnly } from '../api/sequencer';
import type { LatLon, Mode, NamedPoint, RouteResponse } from '../types';

export const DEBOUNCE_MS = 200;

export interface PlannerInputs {
  mode: Mode;
  origin: NamedPoint | null;
  destination: NamedPoint | null;
  maxGap: number;
  excluded: string[];
  /** Optional planning experiment: hypothetical benches (never stored). */
  hypothetical?: LatLon[];
}

export interface PlannerState {
  result: RouteResponse | null;
  /** The inputs the current result was computed for. */
  resultFor: PlannerInputs | null;
  pending: boolean;
  networkError: string | null;
}

/**
 * Computes routes for the current inputs once the user has asked for a route.
 *
 * - Changes are debounced (~200 ms) so dragging the slider sends few requests.
 * - Each request aborts the previous one, and only the newest response is
 *   applied (sequence ids), so stale answers never overwrite newer settings.
 * - The previous result stays visible while a new one is pending.
 */
export function useRoutePlanner(inputs: PlannerInputs, enabled: boolean) {
  const [state, setState] = useState<PlannerState>({ result: null, resultFor: null, pending: false, networkError: null });
  const seq = useRef(createLatestOnly());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nonce, setNonce] = useState(0);

  const { mode, origin, destination, maxGap, excluded } = inputs;
  const excludedKey = excluded.join('|');
  const hypoKey = JSON.stringify(inputs.hypothetical ?? []);

  const run = useCallback(
    async (snapshot: PlannerInputs) => {
      if (!snapshot.origin || !snapshot.destination) return;
      const ticket = seq.current.next();
      try {
        const res = await fetchRoute(
          {
            origin: { lat: snapshot.origin.lat, lon: snapshot.origin.lon },
            destination: { lat: snapshot.destination.lat, lon: snapshot.destination.lon },
            max_gap_m: snapshot.maxGap,
            excluded_seat_ids: snapshot.excluded,
            dataset_mode: snapshot.mode,
            client_request_id: String(ticket.id),
            hypothetical_seats: snapshot.hypothetical ?? [],
          },
          ticket.signal,
        );
        if (!seq.current.isLatest(ticket.id)) return;
        setState({ result: res, resultFor: snapshot, pending: false, networkError: null });
      } catch (err) {
        if ((err as Error).name === 'AbortError' || !seq.current.isLatest(ticket.id)) return;
        setState((s) => ({
          ...s,
          pending: false,
          networkError: 'Could not reach the route service. This is a connection problem, not a finding about seats.',
        }));
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !origin || !destination) return;
    setState((s) => ({ ...s, pending: true }));
    if (timer.current) clearTimeout(timer.current);
    const snapshot: PlannerInputs = {
      mode,
      origin,
      destination,
      maxGap,
      excluded: excludedKey ? excludedKey.split('|') : [],
      hypothetical: JSON.parse(hypoKey) as LatLon[],
    };
    timer.current = setTimeout(() => void run(snapshot), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, mode, origin, destination, maxGap, excludedKey, hypoKey, nonce, run]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const clear = useCallback(() => {
    seq.current.cancel();
    setState({ result: null, resultFor: null, pending: false, networkError: null });
  }, []);

  return { ...state, refresh, clear };
}
