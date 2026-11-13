import { describe, expect, it } from 'vitest';
import { AGG_GRACE_MS, AGG_RETAIN_FINALIZED_MS, type MetricValues } from '@epicenter/shared';
import { Aggregator, type MinutePoint, type Point } from './aggregator';

const T0 = 1_700_000_000_000; // a whole second (and minute: 1_700_000_000_000 % 60_000 === 20_000, so use T0m below)
const T0m = Math.floor(T0 / 60_000) * 60_000;
const m = (cpu: number, lat = 10, extra: Partial<MetricValues> = {}): MetricValues => ({
  cpu, mem: 50, disk: 30, netIn: 100, netOut: 200, lat, err: 0, rps: 10, ...extra,
});
const N = 'us-east-1a.db.01';

function setup() {
  const agg = new Aggregator();
  const points: { p: Point; c: boolean }[] = [];
  const minutes: { p: MinutePoint; c: boolean }[] = [];
  agg.on({ point: (p, c) => points.push({ p, c }), minute: (p, c) => minutes.push({ p, c }) });
  return { agg, points, minutes };
}

describe('Aggregator (1 s)', () => {
  it('averages a bucket and keeps latMax', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: N, ts: T0 + 100, m: m(10, 5) }, T0 + 100);
    agg.add({ nodeId: N, ts: T0 + 600, m: m(30, 25) }, T0 + 600);
    agg.tick(T0 + 1000 + AGG_GRACE_MS);
    expect(points).toHaveLength(1);
    expect(points[0]!.p).toMatchObject({ nodeId: N, ts: T0, n: 2, cpu: 20, lat: 15, latMax: 25, rev: 0 });
    expect(points[0]!.c).toBe(false);
  });

  it('does not finalize before the grace period ends', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: N, ts: T0, m: m(10) }, T0);
    agg.tick(T0 + 1000 + AGG_GRACE_MS - 1);
    expect(points).toHaveLength(0);
    expect(agg.second.openCount()).toBe(1);
    agg.tick(T0 + 1000 + AGG_GRACE_MS);
    expect(points).toHaveLength(1);
    expect(agg.second.openCount()).toBe(0);
  });

  it('an event inside the grace period lands in the original bucket without a correction', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: N, ts: T0 + 100, m: m(10) }, T0 + 100);
    expect(agg.add({ nodeId: N, ts: T0 + 900, m: m(20) }, T0 + 2_500)).toBe('open');
    agg.tick(T0 + 3_000);
    expect(points.map((x) => x.p.cpu)).toEqual([15]);
  });

  it('a late event corrects a finalized bucket: rev increments and the point is re-emitted', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: N, ts: T0, m: m(10) }, T0);
    agg.tick(T0 + 3_000);
    expect(agg.add({ nodeId: N, ts: T0 + 500, m: m(30) }, T0 + 4_000)).toBe('late');
    agg.tick(T0 + 4_250);
    expect(points).toHaveLength(2);
    expect(points[1]!.c).toBe(true);
    expect(points[1]!.p).toMatchObject({ ts: T0, n: 2, cpu: 20, rev: 1 });
    // a second correction bumps rev again
    agg.add({ nodeId: N, ts: T0 + 700, m: m(50) }, T0 + 5_000);
    agg.tick(T0 + 5_250);
    expect(points[2]!.p).toMatchObject({ ts: T0, n: 3, cpu: 30, rev: 2 });
  });

  it('many late events in one tick produce one correction', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: N, ts: T0, m: m(10) }, T0);
    agg.tick(T0 + 3_000);
    for (let i = 0; i < 20; i++) agg.add({ nodeId: N, ts: T0 + i, m: m(10) }, T0 + 3_100);
    agg.tick(T0 + 3_250);
    expect(points.filter((x) => x.c)).toHaveLength(1);
    expect(points[1]!.p.rev).toBe(1);
  });

  it('nothing is emitted again when no late event arrives', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: N, ts: T0, m: m(10) }, T0);
    for (let t = 3_000; t < 10_000; t += 250) agg.tick(T0 + t);
    expect(points).toHaveLength(1);
  });

  it('expires finalized buckets after the retention window', () => {
    const { agg } = setup();
    agg.add({ nodeId: N, ts: T0, m: m(10) }, T0);
    const evict = T0 + 1000 + AGG_GRACE_MS + AGG_RETAIN_FINALIZED_MS;
    agg.tick(evict - 1);
    expect(agg.add({ nodeId: N, ts: T0, m: m(10) }, evict - 1)).toBe('late');
    agg.tick(evict);
    expect(agg.add({ nodeId: N, ts: T0, m: m(10) }, evict)).toBe('expired');
  });

  it('emits buckets in time order and keeps nodes separate', () => {
    const { agg, points } = setup();
    agg.add({ nodeId: 'b.db.01', ts: T0 + 1000, m: m(1) }, T0);
    agg.add({ nodeId: 'a.db.01', ts: T0, m: m(2) }, T0);
    agg.add({ nodeId: 'b.db.01', ts: T0, m: m(3) }, T0);
    agg.tick(T0 + 10_000);
    expect(points.map((x) => [x.p.ts - T0, x.p.nodeId, x.p.cpu])).toEqual([
      [0, 'a.db.01', 2],
      [0, 'b.db.01', 3],
      [1000, 'b.db.01', 1],
    ]);
  });
});

describe('Aggregator (1 min)', () => {
  it('rolls a minute with averages and maxima once the minute and grace have passed', () => {
    const { agg, minutes } = setup();
    for (let s = 0; s < 60; s++) {
      agg.add({ nodeId: N, ts: T0m + s * 1000, m: m(s, 10 + s, { err: s % 7 }) }, T0m + s * 1000);
    }
    agg.tick(T0m + 60_000 + AGG_GRACE_MS - 1);
    expect(minutes).toHaveLength(0);
    agg.tick(T0m + 60_000 + AGG_GRACE_MS);
    expect(minutes).toHaveLength(1);
    expect(minutes[0]!.p).toMatchObject({ ts: T0m, n: 60, cpu: 29.5, cpuMax: 59, latMax: 69, errMax: 6, memMax: 50, rev: 0 });
  });
});
