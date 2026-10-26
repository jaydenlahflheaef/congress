import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ResultCard } from '../components/ResultCard';
import { PrintSummary } from '../components/PrintSummary';
import type { RouteResponse } from '../types';
import { failure, okRoute, unmetRoute } from './fixtures';

function renderCard(result: RouteResponse | null, extra: Partial<Parameters<typeof ResultCard>[0]> = {}) {
  const props = {
    result,
    pending: false,
    currentMaxGap: result?.requested_max_gap_m ?? 150,
    networkError: null,
    selectedLeg: null,
    onSelectLeg: vi.fn(),
    excluded: [],
    seatsById: {},
    onExclude: vi.fn(),
    onRestore: vi.fn(),
    onPrint: vi.fn(),
    limitationNote: 'Seat records can be incomplete or outdated.',
    ...extra,
  };
  render(<ResultCard {...props} />);
  return props;
}

describe('ResultCard', () => {
  it('shows a feasible result with metrics and itinerary', () => {
    renderCard(okRoute(150));
    expect(screen.getByTestId('status-heading')).toHaveTextContent('Within your selected limit');
    expect(screen.getByText(/Based on recorded seating and mapped paths/)).toBeInTheDocument();
    expect(screen.getByTestId('metric-total')).toHaveTextContent('300 m');
    expect(screen.getByTestId('metric-rests')).toHaveTextContent('2');
    expect(screen.getByTestId('leg-list').querySelectorAll('li')).toHaveLength(3);
  });

  it('highlights over-limit legs when the limit cannot be met', () => {
    renderCard(unmetRoute(100));
    expect(screen.getByTestId('status-heading')).toHaveTextContent('Limit not met');
    expect(screen.getByText(/smallest achievable longest gap is 136 m/)).toBeInTheDocument();
    expect(screen.getAllByText(/over your limit by 36 m/)).toHaveLength(2);
  });

  it('never labels an old result as meeting a newly selected limit', () => {
    renderCard(okRoute(150), { currentMaxGap: 120, pending: true });
    expect(screen.getByRole('status')).toHaveTextContent('Updating for 120 m');
    expect(screen.getByTestId('status-heading')).toHaveTextContent('(150 m)');
  });

  it.each([
    ['disconnected', 'do not connect'],
    ['unsupported_area', 'outside the'],
    ['endpoint_unresolved', 'more than 60 m'],
    ['data_unavailable', 'not been imported'],
    ['error', 'software error'],
  ] as const)('explains the %s status in text', (status, msg) => {
    renderCard(failure(status, `Explanation: ${msg}.`));
    expect(screen.getByTestId('status-message')).toHaveTextContent(msg);
    expect(screen.queryByTestId('leg-list')).toBeNull();
  });

  it('exclude and restore buttons call back with the seat id', async () => {
    const props = renderCard(okRoute(150), { excluded: ['s9'], seatsById: {} });
    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude this seat' })[0]);
    expect(props.onExclude).toHaveBeenCalledWith('s1');
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(props.onRestore).toHaveBeenCalledWith('s9');
  });

  it('shows a network error as an error, not as no route', () => {
    renderCard(null, { networkError: 'Could not reach the route service. This is a connection problem.' });
    expect(screen.getByRole('alert')).toHaveTextContent('connection problem');
  });
});

describe('PrintSummary', () => {
  it('lists legs, seats, data version and the limitation note without the map', () => {
    render(
      <PrintSummary
        result={unmetRoute(100)}
        origin={{ name: 'Start Place', lat: 0, lon: 0 }}
        destination={{ name: 'End Place', lat: 0, lon: 0 }}
        datasetDate="2026-10-26"
      />,
    );
    const el = screen.getByTestId('print-summary');
    expect(el).toHaveTextContent('Start Place');
    expect(el).toHaveTextContent('Maximum distance between rests: 100 m');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el).toHaveTextContent('Over limit by 36 m');
    expect(el).toHaveTextContent('synthetic-test');
    expect(el).toHaveTextContent('Seat records can be incomplete');
  });
});

describe('hypothetical bench comparison', () => {
  it('shows with vs without and labels the stop as not a real seat', () => {
    const base = okRoute(100, ['s1'], 250);
    const r = {
      ...base,
      stops: [{ ...base.stops[0], id: '@hyp1', label: 'Hypothetical bench 1', hypothetical: true }],
      hypothetical: {
        benches: [{ id: '@hyp1', label: 'Hypothetical bench 1', lat: 0, lon: 0, moved_m: 2 }],
        used: ['@hyp1'],
        without: { status: 'limit_unmet' as const, total_distance_m: 240, longest_gap_m: 136, minimum_required_gap_m: 136, rest_count: 0 },
        note: 'Hypothetical benches are a planning experiment.',
      },
    };
    renderCard(r);
    const box = screen.getByTestId('hypo-compare');
    expect(box).toHaveTextContent('Without');
    expect(box).toHaveTextContent('136 m');
    expect(box).toHaveTextContent('Limit not met');
    expect(screen.getByText(/Not a real seat/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exclude this seat' })).toBeNull();
  });
});
