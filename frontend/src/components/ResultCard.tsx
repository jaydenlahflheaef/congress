import type { RouteResponse, Seat, Stop } from "../types";
import { STATUS_HEADINGS, fmtDate, fmtM, sourceName, yesNo } from "../format";

interface Props {
  result: RouteResponse | null;
  pending: boolean;
  currentMaxGap: number;
  networkError: string | null;
  selectedLeg: number | null;
  onSelectLeg: (index: number | null) => void;
  excluded: string[];
  seatsById: Record<string, Seat>;
  onExclude: (id: string) => void;
  onRestore: (id: string) => void;
  onPrint: () => void;
  limitationNote: string;
}

/**
 * Google Maps walking directions from wherever the viewer is now. Leaving
 * out the origin is what lets Google Maps start turn-by-turn navigation.
 * Maps URLs need no API key.
 */
export function directionsUrl([lon, lat]: [number, number]): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=walking`;
}

function StopDetails({
  stop,
  onExclude,
}: {
  stop: Stop;
  onExclude: (id: string) => void;
}) {
  if (stop.hypothetical) {
    return (
      <li className="stop hyp">
        <div className="stop-head">
          <span className="stop-badge hyp" aria-hidden="true">
            {stop.number}
          </span>
          <div>
            <strong>
              Stop {stop.number}: {stop.label}
            </strong>
            <div className="muted">
              Not a real seat. Placed by you as a planning experiment.
            </div>
          </div>
        </div>
      </li>
    );
  }
  const verified = stop.last_field_verified_at
    ? `Field-checked ${fmtDate(stop.last_field_verified_at)} (still may be occupied)`
    : "On record only; not field-checked";
  return (
    <li className="stop">
      <div className="stop-head">
        <span className="stop-badge" aria-hidden="true">
          {stop.number}
        </span>
        <div>
          <strong>
            Seat {stop.number}: {stop.label || stop.type_label}
          </strong>
          <div className="muted">{stop.type_label}</div>
        </div>
      </div>
      <details className="seat-details">
        <summary>Seat details & source</summary>
        <dl className="seat-facts">
          <dt>Source</dt>
          <dd>
            {[
              ...new Set(stop.source_refs.map((r) => sourceName(r.source))),
            ].join(" + ")}
          </dd>
          <dt>Backrest</dt>
          <dd>{yesNo(stop.backrest)}</dd>
          <dt>Covered</dt>
          <dd>{yesNo(stop.covered)}</dd>
          <dt>Status</dt>
          <dd>{verified}</dd>
          <dt>Imported</dt>
          <dd>{fmtDate(stop.imported_at)}</dd>
        </dl>
      </details>
      <button
        type="button"
        className="btn small"
        onClick={() => onExclude(stop.id)}
      >
        Exclude this seat
      </button>
    </li>
  );
}

export function ResultCard(props: Props) {
  const { result, pending, currentMaxGap, networkError } = props;

  if (!result && !pending && !networkError) {
    return (
      <section className="card result" aria-label="Route result">
        <p className="muted">
          Choose a start and a destination, set how far you want to walk between
          rests, then press Find my walk.
        </p>
      </section>
    );
  }

  const stale =
    !!result && (pending || result.requested_max_gap_m !== currentMaxGap);
  const hasRoute =
    !!result && (result.status === "ok" || result.status === "limit_unmet");
  const legEnd = (index: number) => {
    const coords = result?.route_geojson?.features.find(
      (f) => f.properties.index === index,
    )?.geometry.coordinates;
    return coords?.[coords.length - 1];
  };

  return (
    <section
      className="card result"
      aria-label="Route result"
      aria-busy={pending}
    >
      {networkError && (
        <p className="notice error" role="alert">
          {networkError}
        </p>
      )}
      {stale && (
        <p className="notice updating" role="status">
          Updating for {currentMaxGap} m… showing the previous result for{" "}
          {result!.requested_max_gap_m} m.
        </p>
      )}
      {!result && pending && (
        <p className="notice updating" role="status">
          Finding a route…
        </p>
      )}
      {result && (
        <div className={stale ? "dim" : undefined}>
          <h2
            className={`status status-${result.status}`}
            data-testid="status-heading"
          >
            {STATUS_HEADINGS[result.status] ?? result.status}
            {result.status === "ok" && (
              <span className="status-limit">
                {" "}
                ({result.requested_max_gap_m} m)
              </span>
            )}
          </h2>
          <p data-testid="status-message">{result.message}</p>

          {hasRoute && (
            <>
              <dl className="metrics">
                <div>
                  <dt>Total distance</dt>
                  <dd data-testid="metric-total">
                    {fmtM(result.total_distance_m)}
                  </dd>
                </div>
                <div>
                  <dt>Longest stretch</dt>
                  <dd
                    data-testid="metric-longest"
                    className={
                      result.status === "limit_unmet" ? "amber" : undefined
                    }
                  >
                    {fmtM(result.longest_gap_m)}
                  </dd>
                </div>
                <div>
                  <dt>Planned rests</dt>
                  <dd data-testid="metric-rests">{result.rest_count}</dd>
                </div>
                <div>
                  <dt>Added for rests</dt>
                  <dd data-testid="metric-extra">
                    +{fmtM(result.extra_distance_m)}
                    <span className="muted small">
                      {" "}
                      (shortest {fmtM(result.comparison_distance_m)})
                    </span>
                  </dd>
                </div>
              </dl>

              <h3>Your walk, step by step</h3>
              <p className="muted small">
                When you set off, tap <strong>Google Maps</strong> on a stretch
                for turn-by-turn walking directions from where you are. Google
                may pick slightly different streets.
              </p>
              <ol className="legs" data-testid="leg-list">
                {result.legs.map((leg) => (
                  <li key={leg.index}>
                    <button
                      type="button"
                      className={`leg ${leg.over_limit ? "over" : ""} ${props.selectedLeg === leg.index ? "selected" : ""}`}
                      onClick={() =>
                        props.onSelectLeg(
                          props.selectedLeg === leg.index ? null : leg.index,
                        )
                      }
                      aria-pressed={props.selectedLeg === leg.index}
                    >
                      <span>
                        {leg.from_label} → {leg.to_label}
                      </span>
                      <span className="leg-dist">{fmtM(leg.distance_m)}</span>
                      {leg.over_limit && (
                        <span className="tag amber">
                          over your limit by {fmtM(leg.exceeds_by_m)}
                        </span>
                      )}
                    </button>
                    {!leg.to_id.startsWith("@hyp") && legEnd(leg.index) && (
                      <a
                        className="leg-nav"
                        href={directionsUrl(legEnd(leg.index)!)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Walking directions to ${leg.to_label} in Google Maps`}
                      >
                        Google Maps <span aria-hidden="true">↗</span>
                      </a>
                    )}
                  </li>
                ))}
              </ol>

              {result.stops.length > 0 && (
                <>
                  <h3>Planned rests</h3>
                  <ol className="stops">
                    {result.stops.map((s) => (
                      <StopDetails
                        key={s.id}
                        stop={s}
                        onExclude={props.onExclude}
                      />
                    ))}
                  </ol>
                </>
              )}
            </>
          )}

          {result.hypothetical && hasRoute && (
            <div className="hypo-compare" data-testid="hypo-compare">
              <h3>
                With vs without your hypothetical bench
                {result.hypothetical.benches.length > 1 ? "es" : ""}
              </h3>
              <table>
                <thead>
                  <tr>
                    <th scope="col"></th>
                    <th scope="col">Without</th>
                    <th scope="col">With</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Result</th>
                    <td>
                      {result.hypothetical.without.status === "ok"
                        ? "Within limit"
                        : "Limit not met"}
                    </td>
                    <td>
                      {result.status === "ok"
                        ? "Within limit"
                        : "Limit not met"}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Longest leg</th>
                    <td>{fmtM(result.hypothetical.without.longest_gap_m)}</td>
                    <td>{fmtM(result.longest_gap_m)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Total</th>
                    <td>
                      {fmtM(result.hypothetical.without.total_distance_m)}
                    </td>
                    <td>{fmtM(result.total_distance_m)}</td>
                  </tr>
                </tbody>
              </table>
              {result.hypothetical.used.length === 0 && (
                <p className="small">
                  The best route does not use your hypothetical bench.
                </p>
              )}
              <p className="muted small">{result.hypothetical.note}</p>
            </div>
          )}

          {props.excluded.length > 0 && (
            <div className="excluded">
              <h3>Seats you excluded for this trip</h3>
              <ul>
                {props.excluded.map((id) => (
                  <li key={id}>
                    {props.seatsById[id]?.label || id}{" "}
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => props.onRestore(id)}
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.warnings.length > 0 && (
            <details className="data-details">
              <summary>Map notes ({result.warnings.length})</summary>
              <ul className="warnings">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          <p className="provenance muted small">
            Data:{" "}
            {result.data_mode === "synthetic_demo"
              ? "synthetic demo (fictional)"
              : result.data_mode === "nearby"
                ? "OpenStreetMap paths and seats"
                : "Flushing pilot"}{" "}
            · version {result.dataset_version ?? "n/a"}
          </p>
          {hasRoute && (
            <button type="button" className="btn" onClick={props.onPrint}>
              Print route summary
            </button>
          )}
        </div>
      )}
      <p className="limitation small">{props.limitationNote}</p>
    </section>
  );
}
