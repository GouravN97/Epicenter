import { describe, expect, it } from 'vitest';
import { SHED_HOLD_MS } from '@epicenter/shared';
import { LoadShedder } from './loadShed';
import { TokenBuckets } from './tokenBucket';

describe('LoadShedder', () => {
  it('does not shed under normal lag and buffer', () => {
    const s = new LoadShedder();
    expect(s.sample(12, 0.1, 1000)).toBeNull();
    expect(s.shouldShed(1000)).toBe(false);
  });

  it('sheds for the hold period after p99 lag > 150 ms, then recovers', () => {
    const s = new LoadShedder();
    expect(s.sample(151, 0, 1000)).toBe('loop-lag');
    expect(s.shouldShed(1000)).toBe(true);
    expect(s.shouldShed(1000 + SHED_HOLD_MS - 1)).toBe(true);
    s.sample(20, 0, 1500); // healthy sample does not cancel the hold
    expect(s.shouldShed(1000 + SHED_HOLD_MS - 1)).toBe(true);
    expect(s.shouldShed(1000 + SHED_HOLD_MS)).toBe(false);
  });

  it('sheds when the writer buffer is over 75% full', () => {
    const s = new LoadShedder();
    expect(s.sample(5, 0.75, 0)).toBeNull();
    expect(s.sample(5, 0.76, 0)).toBe('write-buffer');
    expect(s.shouldShed(1)).toBe(true);
  });

  it('a sustained overload keeps extending the hold', () => {
    const s = new LoadShedder();
    for (let t = 0; t <= 5000; t += 500) s.sample(400, 0, t);
    expect(s.shouldShed(5000 + SHED_HOLD_MS - 1)).toBe(true);
  });

  it('exposes the latest gauges', () => {
    const s = new LoadShedder();
    s.sample(42.5, 0.3, 0);
    expect([s.loopLagP99, s.writerFill]).toEqual([42.5, 0.3]);
  });
});

describe('TokenBuckets', () => {
  it('starts full and admits until the burst is spent', () => {
    const b = new TokenBuckets();
    expect(b.admit('a', 10, 20, 0)).toEqual({ ok: true });
    b.charge('a', 20, 10, 20, 0);
    expect(b.admit('a', 10, 20, 0)).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it('refills at the rate, capped at the burst', () => {
    const b = new TokenBuckets();
    b.charge('a', 20, 10, 20, 0);
    expect(b.admit('a', 10, 20, 50).ok).toBe(false); // 0.5 tokens
    expect(b.admit('a', 10, 20, 100).ok).toBe(true); // 1 token
    expect(b.tokens('a')).toBeCloseTo(1);
    b.admit('a', 10, 20, 60_000);
    expect(b.tokens('a')).toBe(20);
  });

  it('a large batch can put the bucket in debt; Retry-After reflects it', () => {
    const b = new TokenBuckets();
    b.charge('a', 500, 50, 100, 0); // 100 - 500 = -400
    expect(b.admit('a', 50, 100, 0)).toEqual({ ok: false, retryAfterSec: Math.ceil(401 / 50) });
    expect(b.admit('a', 50, 100, 8_100).ok).toBe(true);
  });

  it('buckets are independent', () => {
    const b = new TokenBuckets();
    b.charge('flood', 100, 50, 100, 0);
    expect(b.admit('flood', 50, 100, 0).ok).toBe(false);
    expect(b.admit('sim', 3000, 6000, 0).ok).toBe(true);
  });
});
