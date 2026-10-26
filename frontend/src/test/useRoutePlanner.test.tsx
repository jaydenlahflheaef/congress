import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBOUNCE_MS, useRoutePlanner, type PlannerInputs } from '../hooks/useRoutePlanner';
import { okRoute } from './fixtures';

type Pending = { body: { max_gap_m: number; client_request_id: string }; resolve: (v: unknown) => void; signal: AbortSignal };

describe('useRoutePlanner', () => {
  let pending: Pending[];

  beforeEach(() => {
    vi.useFakeTimers();
    pending = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return new Promise((resolve) => {
          pending.push({ body, resolve, signal: init.signal as AbortSignal });
        });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const base: PlannerInputs = {
    mode: 'synthetic_demo',
    origin: { name: 'a', lat: 0, lon: 0 },
    destination: { name: 'b', lat: 0.001, lon: 0.001 },
    maxGap: 400,
    excluded: [],
  };
  const respond = (p: Pending, limit: number) =>
    p.resolve({ ok: true, status: 200, json: async () => okRoute(limit) } as unknown as Response);

  it('debounces slider changes', async () => {
    const { rerender } = renderHook((props: PlannerInputs) => useRoutePlanner(props, true), { initialProps: base });
    rerender({ ...base, maxGap: 300 });
    rerender({ ...base, maxGap: 200 });
    rerender({ ...base, maxGap: 150 });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 10);
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].body.max_gap_m).toBe(150);
  });

  it('an old slow response never overwrites a newer slider setting', async () => {
    const { result, rerender } = renderHook((props: PlannerInputs) => useRoutePlanner(props, true), { initialProps: base });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 10);
    });
    rerender({ ...base, maxGap: 150 });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 10);
    });
    expect(pending).toHaveLength(2);
    expect(pending[0].signal.aborted).toBe(true);
    // newer response arrives first, then the stale one
    await act(async () => {
      respond(pending[1], 150);
    });
    await act(async () => {
      respond(pending[0], 400);
    });
    expect(result.current.result?.requested_max_gap_m).toBe(150);
    expect(result.current.pending).toBe(false);
  });

  it('keeps the previous result while a new one is pending', async () => {
    const { result, rerender } = renderHook((props: PlannerInputs) => useRoutePlanner(props, true), { initialProps: base });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 10);
    });
    await act(async () => {
      respond(pending[0], 400);
    });
    rerender({ ...base, maxGap: 120 });
    expect(result.current.pending).toBe(true);
    expect(result.current.result?.requested_max_gap_m).toBe(400);
  });

  it('does nothing until enabled', async () => {
    renderHook(() => useRoutePlanner(base, false));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(pending).toHaveLength(0);
  });
});
