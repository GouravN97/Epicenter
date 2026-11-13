// Writer (plan §8.3). Buffers finalized points and flushes them with one unordered bulkWrite of upserts on
// the unique (nodeId, ts) key every WRITER_FLUSH_MS or WRITER_FLUSH_POINTS, whichever comes first. One
// flush in flight at a time; the buffer is capped and drops its oldest points when full.
//
// Idempotency: the buffer is keyed by (nodeId, ts), so a correction replaces a pending write instead of
// queuing beside it. The upsert filter also requires `rev <= incoming rev`, so an older revision can never
// overwrite a newer one (the filter misses, the upsert's insert hits the unique index, and that duplicate-key
// error is expected and ignored). Replays, retries and restarts therefore never create duplicates.
import type { mongo } from 'mongoose';
import { WRITER_BUFFER_CAP, WRITER_FLUSH_MS, WRITER_FLUSH_POINTS } from '@epicenter/shared';
import type { MinutePoint, Point } from './aggregator';

type Document = mongo.Document;
type Collection = mongo.Collection;
type AnyBulkWriteOperation = mongo.AnyBulkWriteOperation;
type MongoBulkWriteError = mongo.MongoBulkWriteError;

const DUP_KEY = 11000;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** The stored document for a point (ts as a Date, values rounded to 2 dp). */
export function toDoc(p: Point | MinutePoint): Document {
  const d: Document = {
    nodeId: p.nodeId,
    ts: new Date(p.ts),
    n: p.n,
    cpu: r2(p.cpu),
    mem: r2(p.mem),
    disk: r2(p.disk),
    netIn: r2(p.netIn),
    netOut: r2(p.netOut),
    lat: r2(p.lat),
    latMax: r2(p.latMax),
    err: r2(p.err),
    rps: r2(p.rps),
    rev: p.rev,
  };
  if ('cpuMax' in p) {
    d.cpuMax = r2(p.cpuMax);
    d.memMax = r2(p.memMax);
    d.errMax = r2(p.errMax);
  }
  return d;
}

export function upsertOp(p: Point | MinutePoint): AnyBulkWriteOperation {
  return {
    updateOne: {
      filter: { nodeId: p.nodeId, ts: new Date(p.ts), rev: { $lte: p.rev } },
      update: { $set: toDoc(p) },
      upsert: true,
    },
  };
}

/** Insertion-ordered buffer keyed by (nodeId, ts); keeps the highest rev per key; drops oldest beyond cap. */
export class PointBuffer<P extends Point> {
  private map = new Map<string, P>();
  dropped = 0;
  constructor(private readonly cap = WRITER_BUFFER_CAP) {}

  get size(): number {
    return this.map.size;
  }

  add(p: P): void {
    const k = `${p.nodeId}|${p.ts}`;
    const cur = this.map.get(k);
    if (cur && cur.rev > p.rev) return;
    this.map.delete(k); // re-insert at the end so a correction is not dropped as "oldest"
    this.map.set(k, p);
    while (this.map.size > this.cap) {
      this.map.delete(this.map.keys().next().value!);
      this.dropped++;
    }
  }

  take(max: number): P[] {
    const out: P[] = [];
    for (const [k, p] of this.map) {
      if (out.length >= max) break;
      out.push(p);
      this.map.delete(k);
    }
    return out;
  }
}

export interface WriterStats {
  /** Points in the last flush. */
  batch: number;
  /** Duration of the last flush. */
  ms: number;
  /** Points waiting (1 s + 1 m). */
  buffer: number;
  /** Points dropped because the buffer was full, since start. */
  dropped: number;
  /** Writes skipped because the stored point had a newer rev, since start. */
  superseded: number;
  /** Flushes that failed (points were requeued), since start. */
  errors: number;
}

export class Writer {
  private readonly sec = new PointBuffer<Point>();
  private readonly min = new PointBuffer<MinutePoint>();
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  readonly stats: WriterStats = { batch: 0, ms: 0, buffer: 0, dropped: 0, superseded: 0, errors: 0 };

  constructor(
    private readonly col1s: Collection,
    private readonly col1m: Collection,
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  add(p: Point): void {
    this.sec.add(p);
    if (this.sec.size >= WRITER_FLUSH_POINTS) void this.flush();
  }

  addMinute(p: MinutePoint): void {
    this.min.add(p);
  }

  /** Fraction of the 1 s buffer in use (load shedding reads this, §8.4). */
  fill(): number {
    return this.sec.size / WRITER_BUFFER_CAP;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), WRITER_FLUSH_MS);
  }

  /** Stops the timer and writes whatever is left. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.inFlight) await new Promise((r) => setTimeout(r, 20));
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.inFlight) return;
    const secs = this.sec.take(WRITER_FLUSH_POINTS);
    const mins = this.min.take(WRITER_FLUSH_POINTS);
    this.refreshGauges();
    if (secs.length === 0 && mins.length === 0) return;
    this.inFlight = true;
    const t0 = performance.now();
    try {
      await Promise.all([this.write(this.col1s, secs), this.write(this.col1m, mins)]);
      this.stats.batch = secs.length + mins.length;
      this.stats.ms = Math.round(performance.now() - t0);
    } catch (err) {
      // Network or server failure: requeue (rev guards keep this safe) and try again next interval.
      this.stats.errors++;
      for (const p of secs) this.sec.add(p);
      for (const p of mins) this.min.add(p);
      this.log(`[writer] flush failed, ${secs.length + mins.length} points requeued: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.inFlight = false;
      this.refreshGauges();
    }
  }

  private async write(col: Collection, points: Point[]): Promise<void> {
    if (points.length === 0) return;
    try {
      await col.bulkWrite(points.map(upsertOp), { ordered: false });
    } catch (err) {
      const e = err as MongoBulkWriteError;
      const writeErrors = e.writeErrors ? (Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]) : null;
      if (writeErrors && writeErrors.length > 0 && writeErrors.every((w) => w.code === DUP_KEY)) {
        this.stats.superseded += writeErrors.length; // an older rev lost to a newer stored one: expected
        return;
      }
      throw err;
    }
  }

  private refreshGauges(): void {
    this.stats.buffer = this.sec.size + this.min.size;
    this.stats.dropped = this.sec.dropped + this.min.dropped;
  }
}
