import { describe, expect, it } from 'vitest';
import { normalizeRun } from './chaosStore';

describe('normalizeRun', () => {
  it('derives runId and timeToDetectMs from a server run row', () => {
    const row = normalizeRun({ id: 'abc', scenario: 'slow-db', target: 'db', startedAt: 1000, detectedAt: 9500, detectedEpicenter: 'db', correct: true, endedAt: 91_000 });
    expect(row.runId).toBe('abc');
    expect(row.timeToDetectMs).toBe(8500);
    expect(row.endedAt).toBe(91_000);
  });

  it('leaves time to detect null for an undetected run', () => {
    const row = normalizeRun({ id: 'abc', scenario: 'cpu-spike', startedAt: 1000, detectedAt: null });
    expect(row.timeToDetectMs).toBeNull();
    expect(row.correct).toBeNull();
  });

  it('keeps a row that is already a scorecard', () => {
    const row = normalizeRun({ runId: 'r1', scenario: 'slow-db', target: 'db', startedAt: 1000, detectedAt: 5000, timeToDetectMs: 4000, detectedEpicenter: 'db', correct: true });
    expect(row.runId).toBe('r1');
    expect(row.timeToDetectMs).toBe(4000);
  });
});
