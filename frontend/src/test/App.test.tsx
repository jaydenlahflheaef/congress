import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { config, okRoute } from './fixtures';

vi.mock('../components/RouteMap', () => ({
  default: (p: { result: { stops: { number: number; id: string }[] } | null }) => (
    <div data-testid="map">
      {p.result?.stops.map((s) => (
        <span key={s.id} data-testid="map-stop">
          {s.number}:{s.id}
        </span>
      ))}
    </div>
  ),
}));

describe('App', () => {
  let routeBodies: { excluded_seat_ids: string[]; max_gap_m: number }[];

  beforeEach(() => {
    routeBodies = [];
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
        if (url.startsWith('/api/config')) return json(config);
        if (url.startsWith('/api/seats')) return json({ status: 'ok', seats: [] });
        if (url.startsWith('/api/places')) return json({ status: 'ok', places: [] });
        if (url.startsWith('/api/route')) {
          const body = JSON.parse(String(init?.body));
          routeBodies.push(body);
          const stops = ['s1', 's2', 's3'].filter((s) => !body.excluded_seat_ids.includes(s));
          return json(okRoute(body.max_gap_m, stops, 300 + 10 * (3 - stops.length)));
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('excluding a seat re-routes and renumbers the stops and metrics', async () => {
    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText('Saved demo trips'), 'demo');
    await waitFor(() => expect(screen.getByTestId('metric-rests')).toHaveTextContent('3'));
    expect(screen.getAllByTestId('map-stop').map((e) => e.textContent)).toEqual(['1:s1', '2:s2', '3:s3']);

    const stopsList = screen.getByRole('heading', { name: 'Planned rests' }).nextElementSibling as HTMLElement;
    const firstStop = within(stopsList).getAllByRole('listitem')[0];
    await userEvent.click(within(firstStop).getByRole('button', { name: 'Exclude this seat' }));

    await waitFor(() => expect(screen.getByTestId('metric-rests')).toHaveTextContent('2'));
    expect(routeBodies.at(-1)!.excluded_seat_ids).toEqual(['s1']);
    expect(screen.getAllByTestId('map-stop').map((e) => e.textContent)).toEqual(['1:s2', '2:s3']);
    expect(screen.getByTestId('metric-total')).toHaveTextContent('310 m');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('remembers only the slider preference in localStorage', async () => {
    render(<App />);
    const num = await screen.findByLabelText('Maximum distance between rests in meters');
    await userEvent.clear(num);
    await userEvent.type(num, '230{Enter}');
    expect(window.localStorage.getItem('restroute.maxGap')).toBe('230');
    expect(Object.keys(window.localStorage)).toEqual(['restroute.maxGap']);
  });

  it('shows the unavailable live pilot honestly', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Flushing pilot' }));
    expect(screen.getByTestId('live-unavailable')).toHaveTextContent('Not imported yet.');
    expect(screen.queryByTestId('demo-indicator')).toBeNull();
  });
});
