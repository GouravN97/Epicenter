// One chart's data lifecycle (plan §9.2, useSeries steps 1–5), kept free of React so it can be tested.
//
//   1. subscribe to the room first, so live points start landing in the buffer
//   2. fetch history for the range
//   3. upsert the history; overlap with live points resolves by timestamp
//   4. after a reconnect, refetch from just before the last point seen and upsert (gap-fill)
//   5. on close, release the room and the buffer (both ref-counted)
import { GAP_FILL_OVERLAP_MS, METRICS, type ColumnarSeries } from '@epicenter/shared';
import type { RoomManager } from './RoomManager';
import type { SeriesBuffer } from './SeriesBuffer';
import type { TelemetryStore } from './TelemetryStore';

export interface SeriesDeps {
  store: TelemetryStore;
  rooms: RoomManager;
  fetchHistory(room: string, from: number, to: number, signal: AbortSignal): Promise<ColumnarSeries>;
  now(): number;
  /** Resolves when node indexes can be mapped to ids (topology loaded); live points are dropped before that. */
  ready?(): Promise<void>;
}

export type SeriesState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export interface SeriesHandle {
  buffer: SeriesBuffer;
  state(): SeriesState;
  subscribe(fn: (s: SeriesState) => void): () => void;
  /** Refetches the whole range (retry after an error). */
  reload(): void;
  close(): void;
}

export function openSeries(deps: SeriesDeps, room: string, rangeMs: number): SeriesHandle {
  const { store, rooms } = deps;
  const buffer = store.acquire(room);
  const abort = new AbortController();
  const listeners = new Set<(s: SeriesState) => void>();
  let state: SeriesState = { status: 'loading' };
  let closed = false;
  let releaseRoom: (() => void) | null = null;
  /** Newest timestamp held when the connection dropped: where the gap starts. */
  let gapFrom: number | null = null;

  const set = (s: SeriesState) => {
    state = s;
    for (const fn of [...listeners]) fn(s);
  };

  async function load(from: number, to: number): Promise<void> {
    const h = await deps.fetchHistory(room, from, to, abort.signal);
    if (closed) return;
    if (buffer.upsertColumnar(h.t, METRICS.map((m) => h[m]), h.rev)) store.markDirty(room);
  }

  async function loadRange(): Promise<void> {
    set({ status: 'loading' });
    try {
      const now = deps.now();
      await load(now - rangeMs, now);
      if (!closed) set({ status: 'ready' });
    } catch (err) {
      if (!closed) set({ status: 'error', message: err instanceof Error ? err.message : 'Could not load history' });
    }
  }

  async function fillGap(): Promise<void> {
    const now = deps.now();
    const from = gapFrom === null ? now - rangeMs : Math.max(gapFrom - GAP_FILL_OVERLAP_MS, now - rangeMs);
    try {
      await load(from, now);
      gapFrom = null;
      if (!closed && state.status === 'error') set({ status: 'ready' });
    } catch {
      // keep gapFrom: the next reconnect retries from the same place
    }
  }

  const offConn = rooms.onConnection((ev) => {
    if (ev === 'disconnect') {
      if (gapFrom === null && buffer.length) gapFrom = buffer.lastT;
    } else {
      void fillGap();
    }
  });

  void (async () => {
    await deps.ready?.();
    if (closed) return;
    releaseRoom = rooms.acquire(room); // step 1, before the history request
    await loadRange();
  })();

  return {
    buffer,
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reload: () => void loadRange(),
    close() {
      if (closed) return;
      closed = true;
      abort.abort();
      offConn();
      releaseRoom?.();
      store.release(room);
      listeners.clear();
    },
  };
}
