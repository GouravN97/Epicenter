import { useSyncExternalStore } from 'react';
import type { TopologyResponse } from '@epicenter/shared';
import type { ClockSnapshot } from './clock';
import { clock, topology } from './live';

/** The session's topology, or null while it loads. */
export function useTopology(): TopologyResponse | null {
  return useSyncExternalStore(topology.subscribe, topology.getSnapshot);
}

/** Clock mode, speed and playing. The current time itself is read with `clock.now()` inside draws. */
export function useClock(): ClockSnapshot {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot);
}
