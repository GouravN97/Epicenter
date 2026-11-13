// Rollups (plan §8.2). Events fold into (nodeId, bucket) accumulators. A bucket is finalized once its end
// plus a grace period has passed, which emits a Point to the writer, detector, state store and broadcaster.
// Finalized accumulators stay in memory so late events can correct them: the bucket's rev is bumped and the
// point is re-emitted as a correction on the next tick (one re-emit per bucket per tick, however many late
// events arrived). The same machinery produces 1-minute rollups.
import {
  AGG_GRACE_MS,
  AGG_RETAIN_FINALIZED_MS,
  BUCKET_MS,
  METRICS,
  MINUTE_MS,
  type MetricValues,
} from '@epicenter/shared';

/** A finalized 1-second (or 1-minute) data point: metric averages plus maxima. `ts` is the bucket start. */
export interface Point extends MetricValues {
  nodeId: string;
  ts: number;
  /** Events folded into this bucket. */
  n: number;
  latMax: number;
  rev: number;
}
export interface MinutePoint extends Point {
  cpuMax: number;
  memMax: number;
  errMax: number;
}

export type AddResult = 'open' | 'late' | 'expired';

const I_CPU = METRICS.indexOf('cpu');
const I_MEM = METRICS.indexOf('mem');
const I_LAT = METRICS.indexOf('lat');
const I_ERR = METRICS.indexOf('err');

interface Acc {
  nodeId: string;
  /** Bucket start. */
  ts: number;
  n: number;
  sum: Float64Array;
  max: Float64Array;
  rev: number;
  /** Changed since it was last emitted (only meaningful once the bucket is finalized). */
  dirty: boolean;
}

interface Bucket {
  ts: number;
  finalized: boolean;
  accs: Map<string, Acc>;
}

export interface RollupEvent {
  nodeId: string;
  ts: number;
  m: MetricValues;
}

/** One rollup resolution. Buckets are grouped by start time so a tick touches O(buckets), not O(accumulators). */
export class Rollup<P extends Point> {
  private readonly buckets = new Map<number, Bucket>();
  private readonly dirty = new Set<Acc>();

  constructor(
    private readonly sizeMs: number,
    private readonly toPoint: (acc: Acc) => P,
    private readonly graceMs = AGG_GRACE_MS,
    private readonly retainMs = AGG_RETAIN_FINALIZED_MS,
  ) {}

  private finalizeAt = (ts: number) => ts + this.sizeMs + this.graceMs;
  private evictAt = (ts: number) => this.finalizeAt(ts) + this.retainMs;

  add(e: RollupEvent, now: number): AddResult {
    const ts = Math.floor(e.ts / this.sizeMs) * this.sizeMs;
    if (this.evictAt(ts) <= now) return 'expired';
    let b = this.buckets.get(ts);
    if (!b) {
      b = { ts, finalized: false, accs: new Map() };
      this.buckets.set(ts, b);
    }
    let acc = b.accs.get(e.nodeId);
    if (!acc) {
      acc = { nodeId: e.nodeId, ts, n: 0, sum: new Float64Array(METRICS.length), max: new Float64Array(METRICS.length), rev: -1, dirty: false };
      b.accs.set(e.nodeId, acc);
    }
    for (let i = 0; i < METRICS.length; i++) {
      const v = e.m[METRICS[i]!];
      acc.sum[i]! += v;
      if (acc.n === 0 || v > acc.max[i]!) acc.max[i] = v;
    }
    acc.n++;
    if (!b.finalized) return 'open';
    // Late: the bucket was already emitted (or, for a node first seen after finalize, is emitted now).
    acc.dirty = true;
    this.dirty.add(acc);
    return 'late';
  }

  /** Finalizes due buckets, emits corrections, evicts expired buckets. */
  tick(now: number, emit: (p: P, correction: boolean) => void): void {
    const due: Bucket[] = [];
    for (const b of this.buckets.values()) {
      if (b.finalized) {
        if (this.evictAt(b.ts) <= now) {
          for (const acc of b.accs.values()) this.dirty.delete(acc);
          this.buckets.delete(b.ts);
        }
      } else if (this.finalizeAt(b.ts) <= now) due.push(b);
    }
    due.sort((a, b) => a.ts - b.ts);
    for (const b of due) {
      b.finalized = true;
      for (const acc of b.accs.values()) {
        acc.rev = 0;
        emit(this.toPoint(acc), false);
      }
    }
    for (const acc of this.dirty) {
      acc.dirty = false;
      acc.rev++;
      emit(this.toPoint(acc), true);
    }
    this.dirty.clear();
  }

  /** Buckets not yet finalized, across all nodes. */
  openCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) if (!b.finalized) n += b.accs.size;
    return n;
  }
}

function basePoint(acc: Acc): Point {
  const avg = (i: number) => acc.sum[i]! / acc.n;
  const p = { nodeId: acc.nodeId, ts: acc.ts, n: acc.n, latMax: acc.max[I_LAT]!, rev: acc.rev } as Point;
  for (let i = 0; i < METRICS.length; i++) p[METRICS[i]!] = avg(i);
  return p;
}

const minutePoint = (acc: Acc): MinutePoint => ({
  ...basePoint(acc),
  cpuMax: acc.max[I_CPU]!,
  memMax: acc.max[I_MEM]!,
  errMax: acc.max[I_ERR]!,
});

export interface AggregatorListeners {
  /** A finalized 1 s point, or a correction of one (`correction` true, rev > 0). */
  point?: (p: Point, correction: boolean) => void;
  minute?: (p: MinutePoint, correction: boolean) => void;
}

export class Aggregator {
  readonly second = new Rollup<Point>(BUCKET_MS, basePoint);
  readonly minute = new Rollup<MinutePoint>(MINUTE_MS, minutePoint);
  private readonly pointFns: NonNullable<AggregatorListeners['point']>[] = [];
  private readonly minuteFns: NonNullable<AggregatorListeners['minute']>[] = [];
  private timer: NodeJS.Timeout | null = null;

  on(l: AggregatorListeners): void {
    if (l.point) this.pointFns.push(l.point);
    if (l.minute) this.minuteFns.push(l.minute);
  }

  /** Returns the 1 s rollup's verdict: open bucket, late correction, or too old to keep. */
  add(e: RollupEvent, now = Date.now()): AddResult {
    const r = this.second.add(e, now);
    if (r !== 'expired') this.minute.add(e, now);
    return r;
  }

  tick(now = Date.now()): void {
    this.second.tick(now, (p, c) => {
      for (const f of this.pointFns) f(p, c);
    });
    this.minute.tick(now, (p, c) => {
      for (const f of this.minuteFns) f(p, c);
    });
  }

  start(intervalMs: number): void {
    this.timer ??= setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
