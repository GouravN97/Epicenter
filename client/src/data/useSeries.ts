import { useEffect, useState } from 'react';
import { seriesDeps } from './live';
import type { SeriesBuffer } from './SeriesBuffer';
import { openSeries, type SeriesState } from './seriesSession';

export interface UseSeries {
  /** The room's buffer. Draw from it with `store.addDrawer(room, …)`; do not copy it into state. */
  buffer: SeriesBuffer | null;
  state: SeriesState;
  reload: () => void;
}

const LOADING: SeriesState = { status: 'loading' };

/**
 * Live series for a `node:<id>` or `service:<id>` room over the last `rangeMs`: subscribes, loads
 * history, merges both by timestamp, heals after a reconnect, and cleans up on unmount.
 * Only the load status is React state; the points stay in the buffer.
 */
export function useSeries(room: string | null, rangeMs: number): UseSeries {
  const [view, setView] = useState<UseSeries>({ buffer: null, state: LOADING, reload: () => {} });

  useEffect(() => {
    if (!room) {
      setView({ buffer: null, state: LOADING, reload: () => {} });
      return;
    }
    const handle = openSeries(seriesDeps, room, rangeMs);
    const base = { buffer: handle.buffer, reload: handle.reload };
    setView({ ...base, state: handle.state() });
    const off = handle.subscribe((state) => setView({ ...base, state }));
    return () => {
      off();
      handle.close();
    };
  }, [room, rangeMs]);

  return view;
}
