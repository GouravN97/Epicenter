import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { OFFSCREEN_UNSUB_MS } from '@epicenter/shared';
import { rooms } from './live';
import type { RoomState } from './RoomManager';

/**
 * Subscribes to a Socket.IO room while the component is mounted (ref-counted with every other user of
 * the room). With `ref`, the subscription follows visibility: a panel scrolled off-screen unsubscribes
 * after 2 s and re-subscribes when it comes back, so the server only sends what is on screen.
 */
export function useRoom(room: string | null, ref?: RefObject<Element | null>): { state: RoomState | undefined; visible: boolean } {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const el = ref?.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  // `wanted` lags behind `visible` on the way out, so a quick scroll past does not churn subscriptions.
  const [wanted, setWanted] = useState(true);
  useEffect(() => {
    if (visible) {
      setWanted(true);
      return;
    }
    const t = setTimeout(() => setWanted(false), OFFSCREEN_UNSUB_MS);
    return () => clearTimeout(t);
  }, [visible]);

  useEffect(() => {
    if (!room || !wanted) return;
    return rooms.acquire(room);
  }, [room, wanted]);

  const state = useSyncExternalStore(
    (fn) => rooms.subscribe(fn),
    () => (room ? rooms.state(room) : undefined),
  );
  return { state, visible };
}

/** Holds several rooms while mounted, e.g. one fleet room per team. */
export function useRooms(list: readonly string[]): void {
  const key = list.join('\n');
  useEffect(() => {
    const releases = (key ? key.split('\n') : []).map((r) => rooms.acquire(r));
    return () => releases.forEach((release) => release());
  }, [key]);
}
