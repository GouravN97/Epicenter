// Pure helpers for the history API (plan §6.2): resolution choice, range clamping, columnar encoding.
import {
  AUTO_1S_MAX_RANGE_MS,
  BUCKET_MS,
  HISTORY_MAX_POINTS,
  METRICS,
  MINUTE_MS,
  type ColumnarSeries,
  type MetricName,
  type Resolution,
} from '@epicenter/shared';

export type ConcreteRes = '1s' | '1m';
export const RES_MS: Record<ConcreteRes, number> = { '1s': BUCKET_MS, '1m': MINUTE_MS };

/**
 * `auto` picks 1s for ranges up to 30 min, else 1m. `from` is then moved forward so the range holds at most
 * `maxPoints` points (the newest end of the range is kept).
 */
export function resolveRange(
  from: number,
  to: number,
  res: Resolution,
  maxPoints = HISTORY_MAX_POINTS,
): { from: number; to: number; res: ConcreteRes } {
  const r: ConcreteRes = res === 'auto' ? (to - from <= AUTO_1S_MAX_RANGE_MS ? '1s' : '1m') : res;
  return { from: Math.max(from, to - maxPoints * RES_MS[r]), to, res: r };
}

/** Moves `from` forward so the range is at most `maxMs`. */
export const clampRange = (from: number, to: number, maxMs: number): { from: number; to: number } => ({
  from: Math.max(from, to - maxMs),
  to,
});

export type HistoryRow = { ts: Date | number; rev?: number } & Record<MetricName, number>;

export const emptySeries = (res: ConcreteRes): ColumnarSeries =>
  ({ res, t: [], rev: [], ...Object.fromEntries(METRICS.map((m) => [m, []])) }) as unknown as ColumnarSeries;

/**
 * Rows → columns. Output `t` is sorted ascending and unique (the unique index already guarantees one row per
 * (nodeId, ts); if two ever share a ts, the higher rev wins). Every column has the same length as `t`.
 */
export function toColumnar(rows: HistoryRow[], res: ConcreteRes): ColumnarSeries {
  const byTs = new Map<number, HistoryRow>();
  for (const r of rows) {
    const t = typeof r.ts === 'number' ? r.ts : r.ts.getTime();
    const cur = byTs.get(t);
    if (!cur || (r.rev ?? 0) > (cur.rev ?? 0)) byTs.set(t, r);
  }
  const ts = [...byTs.keys()].sort((a, b) => a - b);
  const out = emptySeries(res);
  for (const t of ts) {
    const r = byTs.get(t)!;
    out.t.push(t);
    out.rev.push(r.rev ?? 0);
    for (const m of METRICS) out[m].push(r[m]);
  }
  return out;
}
