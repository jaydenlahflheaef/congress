import type { NamedPoint, RouteResponse } from '../types';
import { STATUS_HEADINGS, fmtM, sourceName } from '../format';

interface Props {
  result: RouteResponse;
  origin: NamedPoint | null;
  destination: NamedPoint | null;
  datasetDate: string | null;
}

/** Text-only route summary. Hidden on screen, shown when printing. */
export function PrintSummary({ result, origin, destination, datasetDate }: Props) {
  return (
    <section className="print-only print-summary" aria-hidden="true" data-testid="print-summary">
      <h1>Rest Route: walking plan</h1>
      <p>
        <strong>From:</strong> {origin?.name ?? 'start'} <br />
        <strong>To:</strong> {destination?.name ?? 'destination'} <br />
        <strong>Maximum distance between rests:</strong> {result.requested_max_gap_m} m <br />
        <strong>Result:</strong> {STATUS_HEADINGS[result.status]}. {result.message}
      </p>
      <p>
        <strong>Total distance:</strong> {fmtM(result.total_distance_m)} · <strong>Longest leg:</strong>{' '}
        {fmtM(result.longest_gap_m)} · <strong>Planned rests:</strong> {result.rest_count}
      </p>
      <table>
        <thead>
          <tr>
            <th>Leg</th>
            <th>From → To</th>
            <th>Distance</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {result.legs.map((l) => (
            <tr key={l.index}>
              <td>{l.index}</td>
              <td>
                {l.from_label} → {l.to_label}
              </td>
              <td>{fmtM(l.distance_m)}</td>
              <td>{l.over_limit ? `Over limit by ${fmtM(l.exceeds_by_m)}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.stops.length > 0 && (
        <>
          <h2>Seats</h2>
          <ol>
            {result.stops.map((s) => (
              <li key={s.id}>
                Seat {s.number}: {s.label || s.type_label} ({s.type_label};{' '}
                {[...new Set(s.source_refs.map((r) => sourceName(r.source)))].join(' + ')};{' '}
                {s.last_field_verified_at ? `field-checked ${s.last_field_verified_at.slice(0, 10)}` : 'on record, not field-checked'})
              </li>
            ))}
          </ol>
        </>
      )}
      {result.hypothetical && (
        <p>
          <strong>Includes hypothetical bench(es) placed as a planning experiment. They are not real seats.</strong>{' '}
          Without them: longest leg {fmtM(result.hypothetical.without.longest_gap_m)}, total{' '}
          {fmtM(result.hypothetical.without.total_distance_m)}.
        </p>
      )}
      <p className="small">
        Data: {result.data_mode === 'synthetic_demo' ? 'synthetic demo (fictional)' : 'Flushing pilot'}, version{' '}
        {result.dataset_version}
        {datasetDate ? `, retrieved ${datasetDate}` : ''}.
      </p>
      <p className="small">{result.limitation_note}</p>
    </section>
  );
}
