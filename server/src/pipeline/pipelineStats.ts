// Pipeline counters (plan §8.8). Ingest counters reset every second. snapshotStats() builds the meta:pt
// payload; writer gauges arrive in A6 and loop lag / shedding / bytes out in A10 (0 until then).
import type { PipelineStats } from '@epicenter/shared';

export interface StatsInput {
  counters: IngestCounters;
  bucketsOpen: number;
  socketsDash: number;
  rooms: number;
  emitsPerSec: number;
  clientE2eP95: number[];
  writer?: { batch: number; ms: number; buffer: number; dropped: number };
  bytesOutPerSec?: number;
  loopLagP99?: number;
  shedding?: boolean;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function snapshotStats(i: StatsInput, now = Date.now()): PipelineStats {
  const c = i.counters;
  return {
    ts: now,
    eps: c.accepted + c.duplicate + c.rejected + c.stale,
    accepted: c.accepted,
    duplicate: c.duplicate,
    outOfOrder: c.outOfOrder,
    lateCorrected: c.lateCorrected,
    stale: c.stale,
    rejected: c.rejected,
    shed429: c.shed429,
    bucketsOpen: i.bucketsOpen,
    writeBatch: i.writer?.batch ?? 0,
    writeMs: i.writer?.ms ?? 0,
    writeBuffer: i.writer?.buffer ?? 0,
    writeDropped: i.writer?.dropped ?? 0,
    socketsDash: i.socketsDash,
    rooms: i.rooms,
    emitsPerSec: i.emitsPerSec,
    bytesOutPerSec: i.bytesOutPerSec ?? 0,
    loopLagP99: i.loopLagP99 ?? 0,
    rssMb: Math.round(process.memoryUsage.rss() / 1048576),
    clientE2eP95: Math.round(median(i.clientE2eP95)),
    shedding: i.shedding ?? false,
  };
}

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
