import { describe, expect, it } from 'vitest';
import { NodeStatus, type FleetDeltaRow, type MetricValues } from '@epicenter/shared';
import { FleetDiffer, aggregateService, fleetRow, percentile, serviceStatus, topoRow } from './snapshots';

const { ok, warn, crit, silent } = NodeStatus;

describe('FleetDiffer', () => {
  it('first diff includes every node; later diffs only changes of ≥1 point or a status change', () => {
    const d = new FleetDiffer();
    expect(d.diff([[0, 10, 50, ok], [1, 20, 60, ok]])).toHaveLength(2);
    expect(d.diff([[0, 10, 50, ok], [1, 20, 60, ok]])).toEqual([]);
    expect(d.diff([[0, 11, 50, ok], [1, 20, 60, warn]])).toEqual([[0, 11, 50, ok], [1, 20, 60, warn]]);
    expect(d.diff([[0, 11, 61, ok], [1, 20, 60, warn]])).toEqual([[0, 11, 61, ok]]);
  });

  it('compares with the last *sent* value, so slow drift is eventually sent', () => {
    const d = new FleetDiffer();
    d.diff([[0, 10, 50, ok]]);
    // rounded values only; this simulates 10 → 10 → 11 over ticks
    expect(d.diff([[0, 10, 50, ok]])).toEqual([]);
    expect(d.diff([[0, 11, 50, ok]])).toEqual([[0, 11, 50, ok]]);
  });

  it('snapshot is the last sent state, sorted by nodeIdx', () => {
    const d = new FleetDiffer();
    d.diff([[5, 1, 1, ok], [2, 2, 2, crit]]);
    d.diff([[5, 9, 1, ok]]);
    expect(d.snapshot()).toEqual([[2, 2, 2, crit], [5, 9, 1, ok]]);
  });

  it('a client applying snapshot + deltas ends with the same view as one that saw every delta', () => {
    const d = new FleetDiffer();
    const early = new Map<number, FleetDeltaRow>();
    const apply = (view: Map<number, FleetDeltaRow>, rows: FleetDeltaRow[]) => rows.forEach((r) => view.set(r[0], r));
    let late: Map<number, FleetDeltaRow> | null = null;
    for (let t = 0; t < 50; t++) {
      const rows: FleetDeltaRow[] = [0, 1, 2].map((i) => [i, Math.round(40 + 10 * Math.sin(t / 3 + i)), 50 + (t % 3), t % 17 === i ? warn : ok]);
      const delta = d.diff(rows);
      apply(early, delta);
      if (late) apply(late, delta);
      if (t === 20) late = new Map(d.snapshot().map((r) => [r[0], r]));
    }
    expect(late && [...late.values()]).toEqual([...early.values()].sort((a, b) => a[0] - b[0]));
  });
});

describe('payload builders', () => {
  const m = (cpu: number, lat: number, rps = 10, err = 0): MetricValues => ({ cpu, mem: 40, disk: 0, netIn: 0, netOut: 0, lat, err, rps });

  it('fleetRow rounds and handles nodes without data', () => {
    expect(fleetRow(3, m(12.6, 1), ok)).toEqual([3, 13, 40, ok]);
    expect(fleetRow(4, null, silent)).toEqual([4, 0, 0, silent]);
  });

  it('percentile uses nearest rank', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
  });

  it('aggregateService: avg cpu/err, p95 lat, summed rps', () => {
    const a = aggregateService(1000, [m(10, 5, 100, 1), m(30, 50, 50, 3)]);
    expect(a).toEqual({ ts: 1000, cpuAvg: 20, memAvg: 40, latP95: 50, errAvg: 2, rps: 150 });
  });

  it('serviceStatus: worst live status, silent nodes make it at least warn, all silent → silent', () => {
    expect(serviceStatus([ok, ok])).toBe(ok);
    expect(serviceStatus([ok, crit, warn])).toBe(crit);
    expect(serviceStatus([ok, silent])).toBe(warn);
    expect(serviceStatus([crit, silent])).toBe(crit);
    expect(serviceStatus([silent, silent])).toBe(silent);
  });

  it('topoRow counts healthy nodes', () => {
    const agg = aggregateService(0, [m(10, 5)]);
    expect(topoRow(6, agg, [ok, warn, ok])).toEqual([6, 10, 5, 0, 10, 2, 3, warn]);
    expect(topoRow(6, undefined, [silent])).toEqual([6, 0, 0, 0, 0, 0, 1, silent]);
  });
});
