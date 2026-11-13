// Pipeline counters (plan §8.8). Ingest counters reset every second; A10 adds the gauges and emits meta:pt.

export interface IngestCounters {
  accepted: number;
  duplicate: number;
  outOfOrder: number;
  lateCorrected: number;
  stale: number;
  rejected: number;
  shed429: number;
}

export const zeroCounters = (): IngestCounters => ({
  accepted: 0,
  duplicate: 0,
  outOfOrder: 0,
  lateCorrected: 0,
  stale: 0,
  rejected: 0,
  shed429: 0,
});

export class PipelineCounters {
  /** Current second. */
  cur = zeroCounters();
  /** The last completed second. */
  prev = zeroCounters();
  /** Since process start. */
  readonly total = zeroCounters();

  add(k: keyof IngestCounters, n = 1): void {
    if (n === 0) return;
    this.cur[k] += n;
    this.total[k] += n;
  }

  /** Call once per second. */
  roll(): IngestCounters {
    this.prev = this.cur;
    this.cur = zeroCounters();
    return this.prev;
  }
}
