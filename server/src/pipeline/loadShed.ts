// Ingest load shedding (plan §8.4.1). Event-loop delay is sampled every SHED_SAMPLE_MS; if its p99 exceeds
// SHED_LAG_P99_MS or the writer buffer is more than SHED_WRITE_BUFFER_RATIO full, ingest answers 429 for the
// next SHED_HOLD_MS. The decision logic is pure (LoadShedder); startLoadShedSampler wires it to perf_hooks.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SHED_HOLD_MS, SHED_LAG_P99_MS, SHED_SAMPLE_MS, SHED_WRITE_BUFFER_RATIO } from '@epicenter/shared';

export type ShedReason = 'loop-lag' | 'write-buffer' | null;

export class LoadShedder {
  private shedUntil = 0;
  /** p99 event-loop delay of the last sample window, ms. */
  loopLagP99 = 0;
  writerFill = 0;
  lastReason: ShedReason = null;

  constructor(
    private readonly lagLimitMs = SHED_LAG_P99_MS,
    private readonly bufferLimit = SHED_WRITE_BUFFER_RATIO,
    private readonly holdMs = SHED_HOLD_MS,
  ) {}

  /** Feeds one sample. Returns the reason shedding was (re)armed, or null. */
  sample(loopLagP99Ms: number, writerFill: number, now: number): ShedReason {
    this.loopLagP99 = loopLagP99Ms;
    this.writerFill = writerFill;
    const reason: ShedReason = loopLagP99Ms > this.lagLimitMs ? 'loop-lag' : writerFill > this.bufferLimit ? 'write-buffer' : null;
    if (reason) {
      this.shedUntil = now + this.holdMs;
      this.lastReason = reason;
    }
    return reason;
  }

  shouldShed(now: number): boolean {
    return now < this.shedUntil;
  }
}

/** Samples the real event loop into `shedder`. Returns a stop function. */
export function startLoadShedSampler(shedder: LoadShedder, writerFill: () => number, log?: (msg: string) => void): () => void {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let shedding = false;
  const timer = setInterval(() => {
    const p99 = h.percentile(99) / 1e6; // ns → ms
    h.reset();
    const now = Date.now();
    const reason = shedder.sample(Math.round(p99 * 10) / 10, writerFill(), now);
    const on = shedder.shouldShed(now);
    if (on !== shedding) log?.(on ? `[shed] ON (${reason}: lag p99 ${p99.toFixed(0)} ms, writer ${(shedder.writerFill * 100).toFixed(0)}%)` : '[shed] off');
    shedding = on;
  }, SHED_SAMPLE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    h.disable();
  };
}
