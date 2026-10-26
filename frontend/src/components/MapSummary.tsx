import type { RouteResponse } from '../types';
import { STATUS_HEADINGS, fmtM } from '../format';

/** Small floating summary over the map so results stay visible while sliding. */
export function MapSummary({ result, pending, currentMaxGap }: { result: RouteResponse | null; pending: boolean; currentMaxGap: number }) {
  if (!result) return null;
  const stale = pending || result.requested_max_gap_m !== currentMaxGap;
  const hasRoute = result.status === 'ok' || result.status === 'limit_unmet';
  return (
    <div className={`map-summary status-box-${result.status} ${stale ? 'stale' : ''}`} data-testid="map-summary" aria-hidden="true">
      <div className="ms-head">
        {result.status === 'ok' ? '✓ ' : result.status === 'limit_unmet' ? '! ' : ''}
        {result.status === 'ok'
          ? `Within ${result.requested_max_gap_m} m`
          : result.status === 'limit_unmet'
            ? `${result.requested_max_gap_m} m not possible here`
            : STATUS_HEADINGS[result.status]}
      </div>
      {hasRoute && (
        <div className="ms-grid">
          <span>Total</span>
          <strong>{fmtM(result.total_distance_m)}</strong>
          <span>Longest leg</span>
          <strong>{fmtM(result.longest_gap_m)}</strong>
          <span>Rests</span>
          <strong>{result.rest_count}</strong>
          {result.status === 'limit_unmet' && (
            <>
              <span>Smallest possible</span>
              <strong>{fmtM(result.minimum_required_gap_m)}</strong>
            </>
          )}
        </div>
      )}
      {result.hypothetical && <div className="ms-hyp">Includes hypothetical bench</div>}
      {stale && <div className="ms-updating">Updating for {currentMaxGap} m…</div>}
    </div>
  );
}
