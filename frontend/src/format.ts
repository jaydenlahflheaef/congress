export function fmtM(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return '–';
  // `|| 0` turns a rounded -0 (e.g. -0.004 m of "extra" distance) into 0, not "-0".
  return `${(Math.round(m) || 0).toLocaleString('en-US')} m`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'not recorded';
  return iso.slice(0, 10);
}

export function yesNo(v: boolean | null | undefined): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'not recorded';
}

export const SOURCE_NAMES: Record<string, string> = {
  osm: 'OpenStreetMap',
  nyc_dot_seating: 'NYC DOT Seating Locations',
  synthetic: 'Synthetic demo (fictional)',
  curated: 'Curated pilot record',
};

export function sourceName(s: string): string {
  return SOURCE_NAMES[s] ?? s;
}

export const STATUS_HEADINGS: Record<string, string> = {
  ok: 'Within your selected limit',
  limit_unmet: 'Limit not met in this mapped area',
  disconnected: 'No connected walking route',
  unsupported_area: 'Outside the covered area',
  endpoint_unresolved: 'Could not place that point on a walkway',
  data_unavailable: 'Walking data unavailable',
  error: 'Something went wrong',
};

/**
 * NYC's restroom hours arrive as one run-on string ("Sunday: Closed Monday:
 * 10:00 am - 8:00 pm ..."); split it into one line per day. Anything else
 * ("8am-4pm, Open later seasonally") stays a single line.
 */
export function splitHours(hours: string | null | undefined): string[] {
  if (!hours) return [];
  return hours
    .split(/\s*(?=(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b)/)
    .map((l) => l.trim())
    .filter(Boolean);
}
