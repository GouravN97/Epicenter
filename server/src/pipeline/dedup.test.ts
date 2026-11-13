import { describe, expect, it } from 'vitest';
import { Dedup } from './dedup';

const ev = (seq: number, bootId = 'boot01', nodeId = 'us-east-1a.db.01') => ({ nodeId, bootId, seq });

describe('Dedup', () => {
  it('accepts first sight and flags exact duplicates', () => {
    const d = new Dedup();
    expect(d.check(ev(0))).toBe('accepted');
    expect(d.check(ev(1))).toBe('accepted');
    expect(d.check(ev(1))).toBe('duplicate');
    expect(d.check(ev(0))).toBe('duplicate');
  });

  it('accepts reordered events once and marks them out of order', () => {
    const d = new Dedup();
    expect(d.check(ev(5))).toBe('accepted');
    expect(d.check(ev(3))).toBe('accepted-out-of-order');
    expect(d.check(ev(4))).toBe('accepted-out-of-order');
    expect(d.check(ev(3))).toBe('duplicate');
    expect(d.check(ev(6))).toBe('accepted');
  });

  it('a shuffled batch sent three times is accepted exactly once per seq', () => {
    const d = new Dedup();
    const seqs = Array.from({ length: 200 }, (_, i) => i);
    const shuffled = [...seqs, ...seqs, ...seqs].sort(() => Math.random() - 0.5);
    const accepted = shuffled.filter((s) => d.check(ev(s)).startsWith('accepted'));
    expect(accepted.sort((a, b) => a - b)).toEqual(seqs);
  });

  it('resets on a new bootId (agent restart: seq starts again at 0)', () => {
    const d = new Dedup();
    for (let i = 0; i < 50; i++) d.check(ev(i, 'bootaa'));
    expect(d.check(ev(0, 'bootbb'))).toBe('accepted');
    expect(d.check(ev(1, 'bootbb'))).toBe('accepted');
    expect(d.check(ev(1, 'bootbb'))).toBe('duplicate');
  });

  it('still dedups stragglers from the previous boot after a restart', () => {
    const d = new Dedup();
    for (let i = 0; i < 10; i++) d.check(ev(i, 'bootaa'));
    d.check(ev(0, 'bootbb'));
    expect(d.check(ev(9, 'bootaa'))).toBe('duplicate');
    expect(d.check(ev(1, 'bootbb'))).toBe('accepted');
  });

  it('nodes are independent', () => {
    const d = new Dedup();
    expect(d.check(ev(1, 'boot01', 'a.db.01'))).toBe('accepted');
    expect(d.check(ev(1, 'boot01', 'b.db.01'))).toBe('accepted');
  });

  it('rejects seqs that fell behind the window as stale, and prunes memory', () => {
    const d = new Dedup(1024, 256);
    for (let i = 0; i <= 3000; i++) d.check(ev(i));
    expect(d.check(ev(3000 - 1024))).toBe('stale');
    expect(d.check(ev(3000 - 1023))).toBe('duplicate');
    // pruned to roughly one window (+ up to one prune interval)
    expect(d.windowSize('us-east-1a.db.01')).toBeLessThanOrEqual(1024 + 256);
  });
});
