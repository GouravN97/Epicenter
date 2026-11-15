import { describe, expect, it } from 'vitest';
import type { PipelineStats } from '@epicenter/shared';
import { NOTES_STUB, PROFILES, quantile, renderHeader, renderSection, sectionEnd, sectionStart, summarize, upsertSection, type Tick } from './report';

const stats = (over: Partial<PipelineStats> = {}): PipelineStats => ({
  ts: 0, eps: 0, accepted: 1000, duplicate: 0, outOfOrder: 0, lateCorrected: 0, stale: 0, rejected: 0, shed429: 0,
  bucketsOpen: 0, writeBatch: 500, writeMs: 10, writeBuffer: 0, writeDropped: 0, socketsDash: 10, rooms: 5,
  emitsPerSec: 40, bytesOutPerSec: 2048, loopLagP99: 20, rssMb: 150, clientE2eP95: 0, shedding: false, ...over,
});

const tick = (t: number, phase: Tick['phase'], over: Partial<PipelineStats> = {}, sent = 1000, batches429 = 0): Tick => ({
  t, phase, stats: stats(over), sent, batches429,
});

describe('quantile', () => {
  it('interpolates between ranks and handles edge cases', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5, 1, 3], 0)).toBe(1);
    expect(quantile([5, 1, 3], 1)).toBe(5);
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('summarize', () => {
  const spec = PROFILES.max;
  const base = { profile: 'max' as const, spec, command: 'npm run stress -- --profile max', startedAt: 0 };
  const clients = [
    { deliveryMs: [2, 4, 6], e2eMs: [2500, 2600], messages: 600, bytes: 60 * 1024, connected: true, seconds: 60 },
    { deliveryMs: [], e2eMs: [], messages: 0, bytes: 0, connected: false, seconds: 0 },
  ];

  it('averages the load phase only and counts shedding seconds and 429s', () => {
    const ticks = [tick(-1, 'warmup', { accepted: 99_999 }), tick(0, 'load', { accepted: 8000, shedding: true, shed429: 3 }, 8000, 2), tick(1, 'load', { accepted: 6000, loopLagP99: 300 }, 6000, 1)];
    const r = summarize({ ...base, ticks, clients, agents: { batches: 40, dropped: 5, thinned: 100 } });
    expect(r.targetEps).toBe(50_000);
    expect(r.acceptedEps).toBe(7000);
    expect(r.sentEvents).toBe(14_000);
    expect(r.batches429).toBe(3);
    expect(r.server).toMatchObject({ sheddingSeconds: 1, shed429Total: 3, loopLagP99Max: 300, loopLagP99Mean: 160 });
    expect(r.clientsConnected).toBe(1);
    expect(r.delivery).toMatchObject({ p50: 4, samples: 3 });
    expect(r.perClientMsgsPerSec).toBe(10);
    expect(r.perClientKBPerSec).toBe(1);
  });

  it('reports when shedding switched off for good after the load', () => {
    const ticks = [tick(0, 'load', { shedding: true }), tick(1, 'recover', { shedding: true }), tick(2, 'recover', { shedding: true }), tick(3, 'recover'), tick(4, 'recover')];
    expect(summarize({ ...base, ticks, clients, agents: { batches: 1, dropped: 0, thinned: 0 } }).recoveredAfterSec).toBe(2);
    const never = [tick(0, 'load'), tick(1, 'recover'), tick(2, 'recover')];
    expect(summarize({ ...base, ticks: never, clients, agents: { batches: 1, dropped: 0, thinned: 0 } }).recoveredAfterSec).toBeNull();
    const stuck = [tick(0, 'load', { shedding: true }), tick(1, 'recover', { shedding: true })];
    expect(summarize({ ...base, ticks: stuck, clients, agents: { batches: 1, dropped: 0, thinned: 0 } }).recoveredAfterSec).toBeNull();
  });
});

describe('BENCHMARKS.md', () => {
  const run = (profile: 'baseline' | 'heavy') =>
    summarize({
      profile,
      spec: PROFILES[profile],
      command: `npm run stress -- --profile ${profile}`,
      startedAt: 0,
      ticks: [tick(0, 'load'), tick(10, 'load')],
      clients: [{ deliveryMs: [3], e2eMs: [2400], messages: 120, bytes: 12_288, connected: true, seconds: 60 }],
      agents: { batches: 10, dropped: 0, thinned: 0 },
    });

  it('renders a section with the command, the key numbers and a timeline', () => {
    const md = renderSection(run('heavy'));
    expect(md.startsWith(sectionStart('heavy'))).toBe(true);
    expect(md.endsWith(sectionEnd('heavy'))).toBe(true);
    expect(md).toContain('500 nodes × 5 Hz = **2,500 events/s offered**, 200 dashboard clients, 60 s measured.');
    expect(md).toContain('npm run stress -- --profile heavy');
    expect(md).toContain('| Events accepted by the server | **1,000 /s** (40.0% of offered) |');
    expect(md).toContain('| Socket delivery (server emit → client), p50 / p95 / p99 | 3 ms / 3 ms / 3 ms (1 samples) |');
    expect(md).toContain('<details><summary>Timeline</summary>');
    expect(md).not.toContain('Shedding off for good'); // only profiles with a recovery phase
  });

  it('replaces a profile section in place and appends new ones after the notes', () => {
    const header = renderHeader({ cpu: 'Test CPU', cores: 4, memGb: 8, os: 'Linux', node: 'v22', mongo: '7.0' }, '2026-11-15');
    let doc = `${header}\n${NOTES_STUB}`;
    doc = upsertSection(doc, 'baseline', '<!-- stress:baseline -->\nFIRST-BASELINE\n<!-- /stress:baseline -->');
    doc = upsertSection(doc, 'heavy', '<!-- stress:heavy -->\nh1\n<!-- /stress:heavy -->');
    doc = upsertSection(doc, 'baseline', '<!-- stress:baseline -->\nSECOND-BASELINE\n<!-- /stress:baseline -->');
    expect(doc).toContain('SECOND-BASELINE');
    expect(doc).not.toContain('FIRST-BASELINE');
    expect(doc.indexOf('SECOND-BASELINE')).toBeLessThan(doc.indexOf('h1'));
    expect(doc.indexOf('## What the numbers say')).toBeLessThan(doc.indexOf('SECOND-BASELINE'));
    expect(doc).toContain('| CPU | Test CPU (4 threads) |');
  });
});
