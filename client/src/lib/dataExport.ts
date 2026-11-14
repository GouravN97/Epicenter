// Metric filters and JSON export. Pure functions (what is selected, what an export file contains) plus
// the one browser call that saves a file. Used by the node page and the alert feed.
import { METRICS, METRIC_UNITS, type AlertDTO, type MetricName } from '@epicenter/shared';

export const METRIC_LABELS: Record<MetricName, string> = {
  cpu: 'CPU',
  mem: 'Memory',
  disk: 'Disk',
  netIn: 'Network in',
  netOut: 'Network out',
  lat: 'Latency',
  err: 'Errors',
  rps: 'Requests',
};

const isMetric = (x: unknown): x is MetricName => typeof x === 'string' && (METRICS as readonly string[]).includes(x);

/** A stored metric selection, in METRICS order. Anything unreadable or empty gives the fallback. */
export function parseMetricSelection(raw: string | null, fallback: readonly MetricName[]): MetricName[] {
  try {
    const list: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(list)) return [...fallback];
    const picked = METRICS.filter((m) => list.includes(m));
    return picked.length ? picked : [...fallback];
  } catch {
    return [...fallback];
  }
}

/** Adds or removes a metric, keeping METRICS order. The last one stays: an empty page explains nothing. */
export function toggleMetric(selected: readonly MetricName[], metric: MetricName): MetricName[] {
  if (!selected.includes(metric)) return METRICS.filter((m) => m === metric || selected.includes(m));
  return selected.length > 1 ? selected.filter((m) => m !== metric) : [...selected];
}

/** Two decimals is finer than any metric is measured; it also hides 32-bit float noise. Gaps become null. */
const tidy = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export interface SeriesExport {
  kind: 'epicenter.node-series';
  version: 1;
  exportedAt: string;
  node: { id: string; service: string; team: string | null; region: string; az: string };
  /** `1s`: one point per second. `1m`: one-minute averages. */
  resolution: '1s' | '1m';
  range: { label: string; from: string | null; to: string | null };
  metrics: { name: MetricName; label: string; unit: string }[];
  /** One row per point, oldest first: `t` (epoch ms), `time` (ISO 8601), then one field per metric. */
  points: ({ t: number; time: string } & Partial<Record<MetricName, number | null>>)[];
}

export function buildSeriesExport(input: {
  node: SeriesExport['node'];
  resolution: '1s' | '1m';
  rangeLabel: string;
  metrics: readonly MetricName[];
  /** Timestamps, oldest first. */
  times: ArrayLike<number>;
  /** The column of each metric, same length as `times`. */
  column: (metric: MetricName) => ArrayLike<number>;
  now: number;
}): SeriesExport {
  const cols = input.metrics.map((m) => [m, input.column(m)] as const);
  const points: SeriesExport['points'] = [];
  for (let i = 0; i < input.times.length; i++) {
    const t = input.times[i]!;
    const row: SeriesExport['points'][number] = { t, time: new Date(t).toISOString() };
    for (const [m, c] of cols) row[m] = tidy(c[i]!);
    points.push(row);
  }
  return {
    kind: 'epicenter.node-series',
    version: 1,
    exportedAt: new Date(input.now).toISOString(),
    node: input.node,
    resolution: input.resolution,
    range: { label: input.rangeLabel, from: points[0]?.time ?? null, to: points.at(-1)?.time ?? null },
    metrics: input.metrics.map((name) => ({ name, label: METRIC_LABELS[name], unit: METRIC_UNITS[name] })),
    points,
  };
}

export interface AlertsExport {
  kind: 'epicenter.alerts';
  version: 1;
  exportedAt: string;
  filter: { state: 'active' | 'all'; metric: string | 'all' };
  count: number;
  alerts: (AlertDTO & { startedTime: string; resolvedTime: string | null })[];
}

/** Alerts on one metric, or all of them. */
export const filterAlertsByMetric = <T extends { metric: string }>(alerts: readonly T[], metric: string | 'all'): T[] =>
  metric === 'all' ? [...alerts] : alerts.filter((a) => a.metric === metric);

export function buildAlertsExport(alerts: readonly AlertDTO[], filter: AlertsExport['filter'], now: number): AlertsExport {
  return {
    kind: 'epicenter.alerts',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    filter,
    count: alerts.length,
    alerts: alerts.map((a) => ({ ...a, startedTime: new Date(a.startedAt).toISOString(), resolvedTime: a.resolvedAt ? new Date(a.resolvedAt).toISOString() : null })),
  };
}

/** `epicenter-<name>-20261114-215700.json`, safe on every filesystem. */
export function exportFilename(name: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `epicenter-${name.replace(/[^a-zA-Z0-9.-]+/g, '-')}-${stamp}.json`;
}

/** Saves `data` as a pretty-printed .json file through the browser's download. */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
