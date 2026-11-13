import { describe, expect, it } from 'vitest';
import { SeriesBuffer } from './SeriesBuffer';

const times = (b: SeriesBuffer) => [...b.times()];
const col = (b: SeriesBuffer, i = 0) => [...b.column(i)];
const snapshot = (b: SeriesBuffer) => ({ t: times(b), a: col(b, 0), b: col(b, 1), rev: [...b.revs()] });

/** Deterministic shuffle so a failure is reproducible. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('SeriesBuffer', () => {
  it('appends in order', () => {
    const b = new SeriesBuffer(2, 10);
    expect(b.length).toBe(0);
    expect(b.firstT).toBeNaN();
    for (let i = 1; i <= 5; i++) expect(b.upsert(i * 1000, [i, i * 10])).toBe(true);
    expect(times(b)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(col(b, 0)).toEqual([1, 2, 3, 4, 5]);
    expect(col(b, 1)).toEqual([10, 20, 30, 40, 50]);
    expect([b.firstT, b.lastT]).toEqual([1000, 5000]);
    expect(b.indexOf(3000)).toBe(2);
    expect(b.indexOf(3500)).toBe(-1);
  });

  it('reads values from an offset, as a wire tuple is laid out', () => {
    const b = new SeriesBuffer(2, 10);
    b.upsert(1000, [99, 1000, 7, 8, 3], 2, 3); // [nodeIdx, ts, a, b, rev]
    expect(snapshot(b)).toEqual({ t: [1000], a: [7], b: [8], rev: [3] });
  });

  it('overwrites an existing timestamp when rev is equal or higher, and ignores a lower rev', () => {
    const b = new SeriesBuffer(2, 10);
    b.upsert(1000, [1, 1]);
    b.upsert(2000, [2, 2]);
    b.upsert(3000, [3, 3]);

    expect(b.upsert(2000, [20, 20], 0, 1)).toBe(true); // correction
    expect(col(b)).toEqual([1, 20, 3]);
    expect([...b.revs()]).toEqual([0, 1, 0]);

    expect(b.upsert(2000, [2, 2], 0, 0)).toBe(false); // stale copy of the uncorrected point
    expect(col(b)).toEqual([1, 20, 3]);

    expect(b.upsert(2000, [21, 21], 0, 1)).toBe(true); // same rev: last write wins
    expect(col(b)).toEqual([1, 21, 3]);
    expect(b.length).toBe(3);
  });

  it('reports no change for an exact duplicate', () => {
    const b = new SeriesBuffer(2, 10);
    b.upsert(1000, [1.1, 2.2], 0, 1);
    const v = b.version;
    expect(b.upsert(1000, [1.1, 2.2], 0, 1)).toBe(false);
    expect(b.version).toBe(v);
  });

  it('inserts an out-of-order point in its place', () => {
    const b = new SeriesBuffer(2, 10);
    for (const t of [1000, 2000, 5000, 6000]) b.upsert(t, [t / 1000, 0]);
    expect(b.upsert(4000, [4, 0])).toBe(true);
    expect(b.upsert(3000, [3, 0])).toBe(true);
    expect(b.upsert(500, [0.5, 0])).toBe(true);
    expect(times(b)).toEqual([500, 1000, 2000, 3000, 4000, 5000, 6000]);
    expect(col(b)).toEqual([0.5, 1, 2, 3, 4, 5, 6]);
  });

  it('evicts the oldest point when full', () => {
    const b = new SeriesBuffer(1, 3);
    for (let i = 1; i <= 5; i++) b.upsert(i, [i]);
    expect(times(b)).toEqual([3, 4, 5]);
    expect(col(b)).toEqual([3, 4, 5]);
    expect(b.length).toBe(3);
  });

  it('when full, an out-of-order insert evicts the oldest, and a point older than the window is dropped', () => {
    const b = new SeriesBuffer(1, 3);
    for (const t of [10, 20, 40]) b.upsert(t, [t]);
    expect(b.upsert(30, [30])).toBe(true);
    expect(times(b)).toEqual([20, 30, 40]);
    expect(b.upsert(5, [5])).toBe(false);
    expect(times(b)).toEqual([20, 30, 40]);
  });

  it('stays correct across many window slides (backing-array compaction)', () => {
    const b = new SeriesBuffer(1, 4);
    const model = new Map<number, number>(); // naive reference: keep the 4 newest timestamps
    const put = (t: number, v: number) => {
      b.upsert(t, [v]);
      model.set(t, v);
      while (model.size > 4) model.delete(Math.min(...model.keys()));
    };
    for (let i = 1; i <= 100; i++) {
      put(i * 10, i);
      if (i % 7 === 0) put(i * 10 - 5, i - 0.5); // an occasional late point
      const expected = [...model.entries()].sort((x, y) => x[0] - y[0]);
      expect(times(b)).toEqual(expected.map((e) => e[0]));
      expect(col(b)).toEqual(expected.map((e) => e[1]));
    }
    expect(times(b)).toEqual([975, 980, 990, 1000]);
  });

  it('ignores a non-finite timestamp', () => {
    const b = new SeriesBuffer(1, 3);
    expect(b.upsert(NaN, [1])).toBe(false);
    expect(b.upsert(Infinity, [1])).toBe(false);
    expect(b.length).toBe(0);
  });

  it('feeding the same points twice in shuffled order yields identical buffers', () => {
    // 300 seconds, with a correction (rev 1) for every tenth second.
    const points: { t: number; v: [number, number]; rev: number }[] = [];
    for (let i = 0; i < 300; i++) {
      points.push({ t: i * 1000, v: [i, i * 2], rev: 0 });
      if (i % 10 === 0) points.push({ t: i * 1000, v: [i + 0.5, i * 2 + 0.5], rev: 1 });
    }

    const inOrder = new SeriesBuffer(2, 400);
    for (const p of points) inOrder.upsert(p.t, p.v, 0, p.rev);

    for (const seed of [1, 2, 3]) {
      const b = new SeriesBuffer(2, 400);
      for (const p of shuffled(points, seed)) b.upsert(p.t, p.v, 0, p.rev);
      for (const p of shuffled(points, seed + 100)) b.upsert(p.t, p.v, 0, p.rev);
      expect(snapshot(b)).toEqual(snapshot(inOrder));
    }
    expect(inOrder.length).toBe(300);
    expect(inOrder.column(0)[10]).toBe(10.5); // the correction won
  });

  it('bulk-upserts a columnar history response and merges it with live points', () => {
    const b = new SeriesBuffer(2, 10);
    b.upsert(3000, [3, 30]); // live points arrived before the history response
    b.upsert(4000, [4, 40]);
    const changed = b.upsertColumnar([1000, 2000, 3000], [[1, 2, 3], [10, 20, 30]], [0, 0, 0]);
    expect(changed).toBe(true);
    expect(snapshot(b)).toEqual({ t: [1000, 2000, 3000, 4000], a: [1, 2, 3, 4], b: [10, 20, 30, 40], rev: [0, 0, 0, 0] });
    expect(b.upsertColumnar([1000, 2000, 3000], [[1, 2, 3], [10, 20, 30]])).toBe(false);
  });

  it('clear empties the buffer', () => {
    const b = new SeriesBuffer(1, 3);
    b.upsert(1, [1]);
    b.clear();
    expect(b.length).toBe(0);
    b.upsert(2, [2]);
    expect(times(b)).toEqual([2]);
  });
});
