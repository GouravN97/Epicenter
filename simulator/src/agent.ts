// One logical ingest agent per region (plan §8.9, §8.4). Collects events for its nodes, flushes a batch every
// AGENT_FLUSH_MS, honours 429 Retry-After, and retries network/5xx failures with the *same* events (same
// seq values) so retries exercise the server's dedup.
import {
  AGENT_BUFFER_CAP,
  AGENT_FLUSH_MS,
  AGENT_THIN_OLDER_THAN_MS,
  BOOT_ID_LEN,
  EVENT_VERSION,
  INGEST_MAX_EVENTS,
  MAX_AGE_MS,
  bucketOf,
  type IngestBatch,
  type MetricValues,
  type TelemetryEventInput,
} from '@epicenter/shared';

/** Sends one batch. Resolves with the HTTP outcome; rejects on network failure. */
export type Transport = (batch: IngestBatch) => Promise<{ status: number; retryAfterSec?: number }>;

/** Events this close to the server's 60 s age limit are dropped instead of sent (they would be rejected). */
const EXPIRE_MARGIN_MS = 5_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8_000;

const BOOT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function newBootId(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < BOOT_ID_LEN; i++) s += BOOT_CHARS[Math.floor(rand() * BOOT_CHARS.length)];
  return s;
}

/**
 * Backpressure thinning (§8.4): events newer than `olderThanMs` are kept as they are; older ones are reduced
 * to one per node per second (the first seen). Order is preserved.
 */
export function thinEvents<T extends { nodeId: string; ts: number }>(
  events: T[],
  now: number,
  olderThanMs = AGENT_THIN_OLDER_THAN_MS,
): T[] {
  const cutoff = now - olderThanMs;
  const seen = new Set<string>();
  return events.filter((e) => {
    if (e.ts >= cutoff) return true;
    const k = `${e.nodeId}|${bucketOf(e.ts)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parseRetryAfter(h: string | null | undefined, fallbackSec = 1): number {
  if (!h) return fallbackSec;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, (d - Date.now()) / 1000) : fallbackSec;
}

export interface AgentStats {
  batches: number;
  sent: number;
  /** Events dropped because the buffer was full, they expired, or the server rejected the whole batch. */
  dropped: number;
  thinned: number;
  retries: number;
  /** HTTP status (or 'net') → count. */
  status: Record<string, number>;
  buffer: number;
  lastError: string | null;
}

export interface AgentOptions {
  agentId: string;
  nodeIds: string[];
  send: Transport;
  now?: () => number;
  rand?: () => number;
  onBatch?: (info: { agentId: string; events: number; seqFrom: number; seqTo: number; status: number | 'net' }) => void;
}

export class Agent {
  readonly agentId: string;
  private readonly send: Transport;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly onBatch: AgentOptions['onBatch'];
  private readonly ids = new Map<string, { bootId: string; seq: number }>();
  private buffer: TelemetryEventInput[] = [];
  private inFlight = false;
  private pausedUntil = 0;
  private thinOnResume = false;
  private backoffMs = 0;
  private timer: NodeJS.Timeout | null = null;
  readonly stats: AgentStats = { batches: 0, sent: 0, dropped: 0, thinned: 0, retries: 0, status: {}, buffer: 0, lastError: null };

  constructor(opts: AgentOptions) {
    this.agentId = opts.agentId;
    this.send = opts.send;
    this.now = opts.now ?? Date.now;
    this.rand = opts.rand ?? Math.random;
    this.onBatch = opts.onBatch;
    for (const id of opts.nodeIds) this.restartNode(id);
  }

  /** Simulates an agent restart for one node: new bootId, seq back to 0. */
  restartNode(nodeId: string): void {
    this.ids.set(nodeId, { bootId: newBootId(this.rand), seq: 0 });
  }

  owns(nodeId: string): boolean {
    return this.ids.has(nodeId);
  }

  record(nodeId: string, ts: number, m: MetricValues): void {
    const id = this.ids.get(nodeId);
    if (!id) throw new Error(`${this.agentId} does not own ${nodeId}`);
    this.buffer.push({ v: EVENT_VERSION, nodeId, bootId: id.bootId, seq: id.seq++, ts, m });
    if (this.buffer.length > AGENT_BUFFER_CAP) {
      const over = this.buffer.length - AGENT_BUFFER_CAP;
      this.buffer.splice(0, over);
      this.stats.dropped += over;
    }
    this.stats.buffer = this.buffer.length;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), AGENT_FLUSH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sends the oldest ≤500 buffered events. No-op while a request is in flight, paused, or backing off. */
  async flush(): Promise<void> {
    const now = this.now();
    if (this.inFlight || now < this.pausedUntil) return;

    const fresh = this.buffer.filter((e) => e.ts >= now - (MAX_AGE_MS - EXPIRE_MARGIN_MS));
    this.stats.dropped += this.buffer.length - fresh.length;
    this.buffer = fresh;
    if (this.thinOnResume) {
      const thinned = thinEvents(this.buffer, now);
      this.stats.thinned += this.buffer.length - thinned.length;
      this.buffer = thinned;
      this.thinOnResume = false;
    }
    this.stats.buffer = this.buffer.length;
    if (this.buffer.length === 0) return;

    // The same array objects are resent on retry, so seq values never change for a given event.
    const events = this.buffer.slice(0, INGEST_MAX_EVENTS);
    const batch = { agentId: this.agentId, sentAt: now, events } as IngestBatch;
    this.inFlight = true;
    let status: number | 'net';
    try {
      const res = await this.send(batch);
      status = res.status;
      if (res.status >= 200 && res.status < 300) {
        this.ack(events.length);
        this.backoffMs = 0;
      } else if (res.status === 429) {
        this.pausedUntil = this.now() + (res.retryAfterSec ?? 1) * 1000;
        this.thinOnResume = true;
      } else if (res.status >= 500) {
        this.backOff(`HTTP ${res.status}`);
      } else {
        // 4xx other than 429 will not succeed on retry; drop the batch rather than block the queue.
        this.buffer.splice(0, events.length);
        this.stats.dropped += events.length;
        this.stats.lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      status = 'net';
      this.backOff(err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight = false;
    }
    this.stats.batches++;
    this.stats.status[status] = (this.stats.status[status] ?? 0) + 1;
    this.stats.buffer = this.buffer.length;
    this.onBatch?.({
      agentId: this.agentId,
      events: events.length,
      seqFrom: Math.min(...events.map((e) => e.seq)),
      seqTo: Math.max(...events.map((e) => e.seq)),
      status,
    });
  }

  private ack(n: number): void {
    this.buffer.splice(0, n);
    this.stats.sent += n;
  }

  private backOff(reason: string): void {
    this.stats.retries++;
    this.stats.lastError = reason;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, this.backoffMs * 2));
    this.pausedUntil = this.now() + this.backoffMs * (0.75 + 0.5 * this.rand());
  }
}

/** HTTP transport over fetch (keep-alive by default in Node 18+). */
export function httpTransport(baseUrl: string, key: string, timeoutMs = 5_000): Transport {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/ingest`;
  return async (batch) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-key': key },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined); // drain so the socket is reused
    return { status: res.status, retryAfterSec: parseRetryAfter(res.headers.get('retry-after')) };
  };
}
