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
  it('links each stretch to Google Maps walking directions, except hypothetical benches', () => {
    const r = okRoute(150, ['s1']);
    r.legs[1] = { ...r.legs[1], to_id: '@hyp1', to_label: 'Hypothetical bench 1' };
    r.route_geojson = {
      type: 'FeatureCollection',
      features: r.legs.map((l, i) => ({
        type: 'Feature',
        properties: { index: l.index },
        geometry: { type: 'LineString', coordinates: [[-73.83, 40.75 + i / 1000], [-73.8301, 40.751 + i / 1000]] },
      })),
    };
    renderCard(r);
    const links = screen.getAllByRole('link', { name: /in Google Maps$/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Walking directions to Seat 1 in Google Maps');
    expect(links[0]).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=40.751000,-73.830100&travelmode=walking',
    );
  });

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

describe('subway elevator alerts and nearby restrooms', () => {
  it('renders station elevator outage alerts, monthly reliability, and nearby restrooms', async () => {
    const base = okRoute(150, ['s1'], 300);
    const onUseAsDestination = vi.fn();
    const r: RouteResponse = {
      ...base,
      station_elevators: [
        {
          endpoint: 'start',
          station_id: '447',
          complex_id: '447',
          station_name: 'Flushing-Main St',
          routes: '7',
          distance_m: 45,
          lat: 40.7596,
          lon: -73.83,
          ada_status: 'ADA accessible',
          elevator_count: 1,
          active_outage_count: 1,
          station_availability_pct: 98.7,
          station_total_outages_2026: 3,
          outage_source: 'snapshot',
          outage_updated_at: '2026-10-26T00:00:00Z',
          elevators: [
            {
              equipment_code: 'EL414',
              description: 'East of Main St & Roosevelt Ave to Manhattan-bound platform.',
              street_access: true,
              ada_compliant: true,
              status: 'outage',
              service_status: 'Out of service',
              alternative_route: 'Use LIRR or Q66 bus.',
              active_outage: {
                equipment_code: 'EL414',
                reason: 'Capital Replacement',
                outage_date: '02/02/2026',
                estimated_return: '10/31/2026',
                is_upcoming: false,
                is_maintenance: false,
              },
              reliability: {
                period: 'Jan–Sep 2026',
                months_recorded: 9,
                availability_pct: 98.7,
                total_outages: 3,
                unscheduled_outages: 2,
              },
            },
          ],
        },
      ],
      nearby_restrooms: [
        {
          id: 'rr-1',
          name: 'Flushing Library, QPL',
          lat: 40.7578,
          lon: -73.8288,
          location_type: 'Library',
          status: 'Operational',
          operational: true,
          accessibility: 'Fully Accessible',
          hours: '10:00 am - 8:00 pm',
          distance_from_route_m: 12,
        },
      ],
    };
    renderCard(r, { onUseAsDestination });
    const elBox = screen.getByTestId('station-elevators');
    expect(elBox).toHaveTextContent('Flushing-Main St (7)');
    expect(elBox).toHaveTextContent('1 of 1 elevator out');
    expect(elBox).toHaveTextContent('EL414');
    expect(elBox).toHaveTextContent('Capital Replacement');
    expect(elBox).toHaveTextContent('98.7% monthly availability');

    const rrBox = screen.getByTestId('nearby-restrooms');
    expect(rrBox).toHaveTextContent('Public restrooms near this walk (1)');
    expect(rrBox).toHaveTextContent('Flushing Library, QPL');
    await userEvent.click(screen.getByRole('button', { name: 'Plan walk to this restroom' }));
    expect(onUseAsDestination).toHaveBeenCalledWith({
      name: 'Flushing Library, QPL (Restroom)',
      lat: 40.7578,
      lon: -73.8288,
    });
  });
});
