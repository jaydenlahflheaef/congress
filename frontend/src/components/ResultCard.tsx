import { useState } from "react";
import type {
  PublicRestroom,
  RouteResponse,
  Seat,
  StationElevator,
  StationElevatorAlert,
  Stop,
} from "../types";
import { STATUS_HEADINGS, fmtDate, fmtM, sourceName, yesNo, splitHours } from "../format";
import { Icon } from "./Icon";

interface Props {
  result: RouteResponse | null;
  pending: boolean;
  currentMaxGap: number;
  networkError: string | null;
  selectedLeg: number | null;
  onSelectLeg: (index: number | null) => void;
  walkingLeg?: number | null;
  onStartWalkLeg?: (index: number | null) => void;
  excluded: string[];
  seatsById: Record<string, Seat>;
  onExclude: (id: string) => void;
  onRestore: (id: string) => void;
  onPrint: () => void;
  limitationNote: string;
  onRefreshElevators?: () => Promise<void>;
  onUseAsDestination?: (point: { name: string; lat: number; lon: number }) => void;
  onFocusRestroom?: (id: string) => void;
}

/**
 * Legacy helper kept for test compatibility if imported directly.
 */
export function directionsUrl([lon, lat]: [number, number]): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=walking`;
}

function ElevatorRow({ el }: { el: StationElevator }) {
  const isOut = el.status === "outage";
  return (
    <li className={`elevator-item ${isOut ? "outage" : "ok"}`}>
      <div className="elevator-head">
        <span className={`elevator-badge ${isOut ? "outage" : "ok"}`}>
          {el.equipment_code}
        </span>
        <div>
          <strong>
            {isOut ? "Outage reported" : "In service (on record)"}
          </strong>
          <div className="muted small">{el.description}</div>
        </div>
      </div>
      {isOut && el.active_outage && (
        <div className="elevator-alert-box">
          {el.active_outage.reason && (
            <div>
              <strong>Reason:</strong> {el.active_outage.reason}
            </div>
          )}
          {el.active_outage.outage_date && (
            <div>
              <strong>Out since:</strong> {el.active_outage.outage_date}
            </div>
          )}
          {el.active_outage.estimated_return && (
            <div>
              <strong>Est. return:</strong>{" "}
              {el.active_outage.estimated_return}
            </div>
          )}
          {el.alternative_route && (
            <details className="seat-details">
              <summary>MTA suggested alternative route</summary>
              <p className="muted small">{el.alternative_route}</p>
            </details>
          )}
        </div>
      )}
      {el.upcoming_outages && el.upcoming_outages.length > 0 && !isOut && (
        <div className="muted small">
          Upcoming work: {el.upcoming_outages[0].reason || "Scheduled"} (
          {el.upcoming_outages[0].outage_date} –{" "}
          {el.upcoming_outages[0].estimated_return})
        </div>
      )}
      {el.reliability && el.reliability.availability_pct !== null && (
        <div className="elevator-reliability small">
          <span>
            <strong>{el.reliability.availability_pct.toFixed(1)}%</strong>{" "}
            monthly availability ({el.reliability.period})
          </span>
          {el.reliability.total_outages !== null && (
            <span>
              {" "}
              · {el.reliability.total_outages} outages (
              {el.reliability.unscheduled_outages ?? 0} unscheduled)
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function StationElevatorsSection({
  stations,
  onRefresh,
}: {
  stations: StationElevatorAlert[];
  onRefresh?: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  if (!stations.length) return null;

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="station-alerts" data-testid="station-elevators">
      <div className="section-head-row">
        <h3>Subway elevator alerts & reliability</h3>
        {onRefresh && stations[0]?.outage_source !== "synthetic" && (
          <button
            type="button"
            className="text-button"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            {refreshing ? "Checking MTA…" : "Check live MTA feed"}
          </button>
        )}
      </div>
      {stations.map((st) => {
        const hasOutage = st.active_outage_count > 0;
        return (
          <div
            key={`${st.endpoint}-${st.station_id}`}
            className={`station-card ${hasOutage ? "has-outage" : ""}`}
          >
            <div className="station-card-head">
              <div>
                <span className="station-role">
                  Near {st.endpoint === "start" ? "start" : "destination"} (
                  {fmtM(st.distance_m)})
                </span>
                <h4>
                  {st.station_name}
                  {st.routes ? ` (${st.routes})` : ""}
                </h4>
              </div>
              <span
                className={`station-pill ${hasOutage ? "amber" : st.elevator_count > 0 ? "teal" : "gray"}`}
              >
                {st.elevator_count === 0
                  ? st.ada_status
                  : hasOutage
                    ? `${st.active_outage_count} of ${st.elevator_count} elevator${st.elevator_count === 1 ? "" : "s"} out`
                    : `${st.elevator_count} elevator${st.elevator_count === 1 ? "" : "s"} in service`}
              </span>
            </div>
            {st.station_availability_pct !== null &&
              st.station_availability_pct !== undefined && (
                <p className="muted small station-summary-line">
                  Station 2026 reliability:{" "}
                  <strong>{st.station_availability_pct.toFixed(1)}%</strong>{" "}
                  hours available
                  {st.station_total_outages_2026 !== null &&
                  st.station_total_outages_2026 !== undefined
                    ? ` (${st.station_total_outages_2026} recorded outage incidents across Jan–Sep 2026)`
                    : ""}
                </p>
              )}
            {st.elevators.length > 0 ? (
              <ul className="elevator-list">
                {st.elevators.map((el) => (
                  <ElevatorRow key={el.equipment_code} el={el} />
                ))}
              </ul>
            ) : (
              <p className="muted small">
                No MTA elevators recorded at this station ({st.ada_status}).
              </p>
            )}
            <p className="muted small station-source-note">
              Outage status:{" "}
              {st.outage_source === "live_mta"
                ? "live MTA ENE feed"
                : st.outage_source === "synthetic"
                  ? "synthetic demo"
                  : "saved MTA snapshot"}
              {st.outage_updated_at
                ? ` (${fmtDate(st.outage_updated_at)})`
                : ""}{" "}
              · Historical availability from NY Open Data (`rc78-7x78`).
            </p>
          </div>
        );
      })}
    </div>
  );
}

function NearbyRestroomsSection({
  restrooms,
  onUseAsDestination,
  onFocusRestroom,
}: {
  restrooms: PublicRestroom[];
  onUseAsDestination?: (point: {
    name: string;
    lat: number;
    lon: number;
  }) => void;
  onFocusRestroom?: (id: string) => void;
}) {
  if (!restrooms.length) return null;
  return (
    <details className="restrooms-section" data-testid="nearby-restrooms">
      <summary>
        Public restrooms near this walk ({restrooms.length})
      </summary>
      <p className="muted small">
        Recorded by NYC Open Data (`i7jb-7jku`). Hours and availability can
        change without notice.
      </p>
      <ul className="restroom-list">
        {restrooms.slice(0, 6).map((rr) => (
          <li key={rr.id} className="restroom-item">
            <div className="restroom-head">
              <strong>{rr.name}</strong>
              <div className="muted small">
                {rr.location_type}
                {rr.distance_from_route_m !== undefined
                  ? ` · ${fmtM(rr.distance_from_route_m)} from route`
                  : ""}
              </div>
              <span
                className={`station-pill ${rr.operational ? "teal" : "amber"}`}
              >
                {rr.status}
              </span>
            </div>
            <div className="restroom-facts">
              <span className="fact">Accessibility: {rr.accessibility}</span>
              {rr.changing_stations && (
                <span className="fact">Changing station: {rr.changing_stations}</span>
              )}
            </div>
            {rr.hours && (
              <ul className="hours" aria-label="Hours">
                {splitHours(rr.hours).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <div className="restroom-actions">
              {onFocusRestroom && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => onFocusRestroom(rr.id)}
                >
                  <Icon name="pin" size={15} /> Show on map
                </button>
              )}
              {onUseAsDestination && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    onUseAsDestination({
                      name: `${rr.name} (Restroom)`,
                      lat: rr.lat,
                      lon: rr.lon,
                    })
                  }
                >
                  <Icon name="walk" size={15} /> Plan walk to this restroom
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
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

              {result.station_elevators &&
                result.station_elevators.length > 0 && (
                  <StationElevatorsSection
                    stations={result.station_elevators}
                    onRefresh={props.onRefreshElevators}
                  />
                )}

              <h3>Your walk, step by step</h3>
              <p className="muted small">
                Tap a stretch or <strong>Walk leg</strong> to follow that step
                directly on the map inside EzWay.
              </p>
              <ol className="legs" data-testid="leg-list">
                {result.legs.map((leg) => {
                  const isActive =
                    props.selectedLeg === leg.index ||
                    props.walkingLeg === leg.index;
                  return (
                    <li key={leg.index}>
                      <button
                        type="button"
                        className={`leg ${leg.over_limit ? "over" : ""} ${isActive ? "selected" : ""}`}
                        onClick={() =>
                          props.onSelectLeg(
                            props.selectedLeg === leg.index ? null : leg.index,
                          )
                        }
                        aria-pressed={isActive}
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
                        <button
                          type="button"
                          className={`leg-nav ${props.walkingLeg === leg.index ? "active" : ""}`}
                          onClick={() => {
                            if (props.onStartWalkLeg) {
                              props.onStartWalkLeg(leg.index);
                            } else {
                              props.onSelectLeg(leg.index);
                            }
                          }}
                          aria-label={`Walk to ${leg.to_label} on map`}
                        >
                          <Icon name="walk" size={16} />{" "}
                          {props.walkingLeg === leg.index
                            ? "Walking"
                            : "Walk leg"}
                        </button>
                      )}
                    </li>
                  );
                })}
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

              {result.nearby_restrooms &&
                result.nearby_restrooms.length > 0 && (
                  <NearbyRestroomsSection
                    restrooms={result.nearby_restrooms}
                    onUseAsDestination={props.onUseAsDestination}
                    onFocusRestroom={props.onFocusRestroom}
                  />
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
