import { describe, expect, it } from 'vitest';
import { METRICS } from '@epicenter/shared';
import { clampRange, resolveRange, toColumnar, type HistoryRow } from './columnar';

const row = (ts: number, cpu: number, rev = 0): HistoryRow => ({
  ts: new Date(ts), rev, cpu, mem: 1, disk: 2, netIn: 3, netOut: 4, lat: 5, err: 6, rps: 7,
});

describe('resolveRange', () => {
  const MIN = 60_000;
  it('auto: 1s up to 30 min, 1m beyond', () => {
    expect(resolveRange(0, 30 * MIN, 'auto').res).toBe('1s');
    expect(resolveRange(0, 30 * MIN + 1, 'auto').res).toBe('1m');
  });

  it('caps the range at 3600 points by moving `from` forward', () => {
    const r = resolveRange(0, 6 * 60 * MIN, '1s'); // 6 h at 1 s = 21 600 points
    expect(r).toEqual({ from: 6 * 60 * MIN - 3600 * 1000, to: 6 * 60 * MIN, res: '1s' });
    expect(resolveRange(1000, 5000, '1s').from).toBe(1000);
  });

  it('clampRange keeps the newest end', () => {
    expect(clampRange(0, 1_000_000, 600_000)).toEqual({ from: 400_000, to: 1_000_000 });
    expect(clampRange(900_000, 1_000_000, 600_000)).toEqual({ from: 900_000, to: 1_000_000 });
  });
});

describe('toColumnar', () => {
  it('produces sorted, unique t with equal-length columns', () => {
    const s = toColumnar([row(3000, 3), row(1000, 1), row(2000, 2)], '1s');
    expect(s.t).toEqual([1000, 2000, 3000]);
    expect(s.cpu).toEqual([1, 2, 3]);
    for (const m of [...METRICS, 'rev'] as const) expect(s[m]).toHaveLength(3);
    expect(s.res).toBe('1s');
  });

  it('duplicate timestamps collapse to the highest rev', () => {
    const s = toColumnar([row(1000, 1, 0), row(1000, 9, 2), row(1000, 5, 1)], '1s');
    expect(s.t).toEqual([1000]);
    expect(s.cpu).toEqual([9]);
    expect(s.rev).toEqual([2]);
  });

  it('accepts epoch-ms ts and empty input', () => {
    expect(toColumnar([{ ...row(0, 1), ts: 5000 }], '1m').t).toEqual([5000]);
    expect(toColumnar([], '1s')).toMatchObject({ t: [], cpu: [], rev: [] });
  });
});
