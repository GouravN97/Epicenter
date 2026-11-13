import { useEffect, useState } from 'react';
import { seriesDeps } from './live';
import type { SeriesBuffer } from './SeriesBuffer';
import { openSeries, type SeriesRes, type SeriesState } from './seriesSession';

export interface UseSeries {
  /** The window's buffer. Draw from it with `store.addDrawer(key, …)`; do not copy it into state. */
  buffer: SeriesBuffer | null;
  /** Store key of the buffer. */
  key: string | null;
  res: SeriesRes;
  /** True when live 1-second points flow into the buffer. */
  live: boolean;
  state: SeriesState;
  reload: () => void;
}

const IDLE: UseSeries = { buffer: null, key: null, res: '1s', live: false, state: { status: 'loading' }, reload: () => {} };

/**
 * Series for a `node:<id>` or `service:<id>` room over the last `rangeMs`, optionally ending
 * `offsetMs` in the past. Short live windows subscribe, load history, merge both by timestamp and
 * heal after a reconnect; long or past windows are polled. Only the load status is React state.
 */
export function useSeries(room: string | null, rangeMs: number, offsetMs = 0): UseSeries {
  const [view, setView] = useState<UseSeries>(IDLE);

  useEffect(() => {
    if (!room) {
      setView(IDLE);
      return;
    }
    const handle = openSeries(seriesDeps, room, rangeMs, { offsetMs });
    const base = { buffer: handle.buffer, key: handle.key, res: handle.res, live: handle.live, reload: handle.reload };
    setView({ ...base, state: handle.state() });
    const off = handle.subscribe((state) => setView({ ...base, state }));
    return () => {
      off();
      handle.close();
    };
  }, [room, rangeMs, offsetMs]);

  return view;
}
