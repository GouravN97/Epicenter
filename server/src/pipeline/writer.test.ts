import { describe, expect, it } from 'vitest';
import type { Point } from './aggregator';
import { PointBuffer, Writer, toDoc, upsertOp } from './writer';

const pt = (nodeId: string, ts: number, rev = 0, cpu = 10): Point => ({
  nodeId, ts, n: 2, rev, cpu, mem: 20.123, disk: 30, netIn: 1, netOut: 2, lat: 3, latMax: 4, err: 0, rps: 5,
});

describe('PointBuffer', () => {
  it('keeps one entry per (nodeId, ts) and the highest rev wins', () => {
    const b = new PointBuffer<Point>();
    b.add(pt('a', 1000, 0, 10));
    b.add(pt('a', 1000, 2, 30));
    b.add(pt('a', 1000, 1, 20)); // older correction arriving late is ignored
    b.add(pt('b', 1000));
    expect(b.size).toBe(2);
    const out = b.take(10);
    expect(out.find((p) => p.nodeId === 'a')).toMatchObject({ rev: 2, cpu: 30 });
    expect(b.size).toBe(0);
  });

  it('the same point added twice (a replay) is buffered once', () => {
    const b = new PointBuffer<Point>();
    for (let i = 0; i < 2; i++) for (let s = 0; s < 50; s++) b.add(pt('a', s * 1000));
    expect(b.size).toBe(50);
  });

  it('take() returns oldest first and respects max', () => {
    const b = new PointBuffer<Point>();
    for (let s = 0; s < 5; s++) b.add(pt('a', s * 1000));
    expect(b.take(2).map((p) => p.ts)).toEqual([0, 1000]);
    expect(b.take(10).map((p) => p.ts)).toEqual([2000, 3000, 4000]);
  });

  it('drops the oldest beyond the cap and counts them; a correction is not treated as oldest', () => {
    const b = new PointBuffer<Point>(3);
    b.add(pt('a', 0));
    b.add(pt('a', 1000));
    b.add(pt('a', 2000));
    b.add(pt('a', 0, 1)); // correction of the oldest moves it to the back
    b.add(pt('a', 3000)); // evicts ts 1000, not the corrected ts 0
    expect(b.dropped).toBe(1);
    expect(b.take(10).map((p) => [p.ts, p.rev])).toEqual([[2000, 0], [0, 1], [3000, 0]]);
  });
});

describe('upsert op', () => {
  it('upserts on (nodeId, ts) and only over an equal-or-older rev', () => {
    const op = upsertOp(pt('a', 5000, 3)) as { updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> }; upsert: boolean } };
    expect(op.updateOne.filter).toEqual({ nodeId: 'a', ts: new Date(5000), rev: { $lte: 3 } });
    expect(op.updateOne.upsert).toBe(true);
    expect(op.updateOne.update.$set).toMatchObject({ nodeId: 'a', rev: 3, mem: 20.12 });
  });

  it('minute docs carry the maxima', () => {
    const d = toDoc({ ...pt('a', 60_000), cpuMax: 90.555, memMax: 50, errMax: 1 });
    expect(d).toMatchObject({ ts: new Date(60_000), cpuMax: 90.56, memMax: 50, errMax: 1 });
    expect('cpuMax' in toDoc(pt('a', 0))).toBe(false);
  });
});

describe('Writer', () => {
  /** A collection whose bulkWrite takes `ms` and records each batch size. */
  const slowCollection = (ms: number, sizes: number[]) =>
    ({
      bulkWrite: async (ops: unknown[]) => {
        sizes.push(ops.length);
        await new Promise((r) => setTimeout(r, ms));
        return {};
      },
    }) as unknown as ConstructorParameters<typeof Writer>[0];

  it('drains a backlog flush after flush without waiting for new points or the timer', async () => {
    const sizes: number[] = [];
    const w = new Writer(slowCollection(5, sizes), slowCollection(0, []));
    w.start();
    // One finalize burst: 3,500 nodes' points arrive at once (the first 1,000 start a flush immediately).
    for (let i = 0; i < 3500; i++) w.add(pt(`n${i}`, 1000));
    await new Promise((r) => setTimeout(r, 100)); // well under the 1 s timer
    // Before the fix only the first batch was written in this time; the rest waited for the next burst.
    expect(sizes).toEqual([1000, 1000, 1000]);
    expect(w.stats.buffer).toBe(500); // under one batch: left for the regular 1 s flush
    await w.stop();
  });
});
