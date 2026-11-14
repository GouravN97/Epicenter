// One chart's data lifecycle (plan §9.2, useSeries steps 1–5), kept free of React so it can be tested.
//
// Live window (range ≤ 30 min, ending now), 1-second points:
//   1. subscribe to the room first, so live points start landing in the buffer
//   2. fetch history for the range
//   3. upsert the history; overlap with live points resolves by timestamp
//   4. after a reconnect, refetch from just before the last point seen and upsert (gap-fill)
//   5. on close, release the room and the buffer (both ref-counted)
//
// Polled window (range > 30 min, or a window that ends in the past such as "1 h ago"):
//   the server answers long ranges with 1-minute points, which must not be mixed with 1-second live
//   points in one buffer. These windows therefore get their own buffer, take no live subscription, and
//   refetch their newest stretch every 30 s.
import { AUTO_1S_MAX_RANGE_MS, GAP_FILL_OVERLAP_MS, METRICS, MINUTE_MS, WRITER_FLUSH_MS, type ColumnarSeries } from '@epicenter/shared';
import type { RoomManager } from './RoomManager';
import type { SeriesBuffer } from './SeriesBuffer';
import type { TelemetryStore } from './TelemetryStore';

export type SeriesRes = '1s' | '1m';

export interface SeriesDeps {
  store: TelemetryStore;
  rooms: RoomManager;
  fetchHistory(room: string, from: number, to: number, signal: AbortSignal, res: SeriesRes): Promise<ColumnarSeries>;
  now(): number;
  /** Resolves when node indexes can be mapped to ids (topology loaded); live points are dropped before that. */
  ready?(): Promise<void>;
}

export interface SeriesOptions {
  /** The window ends this long before now (baseline overlays). Default 0. */
  offsetMs?: number;
  /** Refetch interval for polled windows. Default 30 s. */
  pollMs?: number;
  /**
   * Delay before the seam fill (see below). Defaults to two writer flushes plus a margin.
   */
  seamMs?: number;
}

/**
 * The seam: a second can be finalized and broadcast just before our subscription takes effect, yet still
 * sit in the server's write buffer (flushed every WRITER_FLUSH_MS) when the history query runs, so neither
 * path delivers it. Seen against the real server on every first load. After each history load or gap-fill
 * of a live window, the newest few seconds are fetched once more after the writer has flushed.
 */
const SEAM_MS = 2 * WRITER_FLUSH_MS + 500;

export type SeriesState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export interface SeriesHandle {
  buffer: SeriesBuffer;
  /** Store key of the buffer: register drawers under it. */
  key: string;
  /** Resolution requested from the server. */
  res: SeriesRes;
  /** True when live points flow into the buffer; false for polled windows. */
  live: boolean;
  state(): SeriesState;
  subscribe(fn: (s: SeriesState) => void): () => void;
  /** Refetches the whole range (retry after an error). */
  reload(): void;
  /** Polled windows: refetch the newest stretch now. */
  poll(): Promise<void>;
  close(): void;
}

/** Store key for a window. Live 1-second windows share the room's own key, so they share its buffer. */
export function seriesKey(room: string, rangeMs: number, offsetMs = 0): string {
  const coarse = rangeMs > AUTO_1S_MAX_RANGE_MS;
  return room + (coarse ? '#1m' : '') + (offsetMs ? `#ago${offsetMs}` : '');
}

export function openSeries(deps: SeriesDeps, room: string, rangeMs: number, opts: SeriesOptions = {}): SeriesHandle {
  const { store, rooms } = deps;
  const offsetMs = opts.offsetMs ?? 0;
  const res: SeriesRes = rangeMs > AUTO_1S_MAX_RANGE_MS ? '1m' : '1s';
  const live = res === '1s' && offsetMs === 0;
  const stepMs = res === '1m' ? MINUTE_MS : 1000;
  const key = seriesKey(room, rangeMs, offsetMs);

  const buffer = store.acquire(key);
  const abort = new AbortController();
  const listeners = new Set<(s: SeriesState) => void>();
  let state: SeriesState = { status: 'loading' };
  let closed = false;
  let releaseRoom: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Newest timestamp held when the connection dropped: where the gap starts. */
  let gapFrom: number | null = null;
  const seamTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Live windows: re-read [to − overlap, now] once the server has flushed what was in its write buffer. */
  const fillSeam = (to: number) => {
    if (!live || closed) return;
    const t = setTimeout(() => {
      seamTimers.delete(t);
      if (!closed) void loadTail(to - GAP_FILL_OVERLAP_MS);
    }, opts.seamMs ?? SEAM_MS);
    seamTimers.add(t);
  };

  const set = (s: SeriesState) => {
    state = s;
    for (const fn of [...listeners]) fn(s);
  };
  const windowEnd = () => deps.now() - offsetMs;

  async function load(from: number, to: number): Promise<void> {
    const h = await deps.fetchHistory(room, from, to, abort.signal, res);
    if (closed) return;
    if (buffer.upsertColumnar(h.t, METRICS.map((m) => h[m]), h.rev)) store.markDirty(key);
  }

  async function loadRange(): Promise<void> {
    set({ status: 'loading' });
    try {
      const end = windowEnd();
      await load(end - rangeMs, end);
      if (!closed) set({ status: 'ready' });
      fillSeam(end);
    } catch (err) {
      if (!closed) set({ status: 'error', message: err instanceof Error ? err.message : 'Could not load history' });
    }
  }

  /** Fetches from `from` (clamped to the window) to the window's end. Returns false on failure. */
  async function loadTail(from: number): Promise<boolean> {
    const end = windowEnd();
    try {
      await load(Math.max(from, end - rangeMs), end);
      if (!closed && state.status === 'error') set({ status: 'ready' });
      return true;
    } catch {
      return false;
    }
  }

  async function poll(): Promise<void> {
    if (closed || state.status === 'loading') return;
    // Re-read the last two steps as well: the newest 1-minute point is a running average until its minute closes.
    await loadTail(buffer.length ? buffer.lastT - 2 * stepMs : -Infinity);
  }

  const offConn = rooms.onConnection((ev) => {
    if (ev === 'disconnect') {
      if (gapFrom === null && buffer.length) gapFrom = buffer.lastT;
      return;
    }
    if (!live) {
      void poll();
      return;
    }
    // Gap-fill. If it fails, gapFrom is kept and the next reconnect retries from the same place.
    const end = windowEnd();
    void loadTail(gapFrom === null ? -Infinity : gapFrom - GAP_FILL_OVERLAP_MS).then((ok) => {
      if (!ok) return;
      gapFrom = null;
      fillSeam(end);
    });
  });

  void (async () => {
    await deps.ready?.();
    if (closed) return;
    if (live) releaseRoom = rooms.acquire(room); // step 1, before the history request
    else pollTimer = setInterval(() => void poll(), opts.pollMs ?? 30_000);
    await loadRange();
  })();

  return {
    buffer,
    key,
    res,
    live,
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reload: () => void loadRange(),
    poll,
    close() {
      if (closed) return;
      closed = true;
      abort.abort();
      offConn();
      if (pollTimer) clearInterval(pollTimer);
      for (const t of seamTimers) clearTimeout(t);
      releaseRoom?.();
      store.release(key);
      listeners.clear();
    },
  };
}
