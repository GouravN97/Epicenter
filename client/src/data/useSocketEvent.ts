import { useEffect, useRef } from 'react';
import type { DashS2C } from '@epicenter/shared';
import { onSocketChange } from '../lib/socket';

/** Listens to a server event on the current socket, following it across login and logout. */
export function useSocketEvent<E extends keyof DashS2C>(event: E, handler: DashS2C[E]): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let off: (() => void) | null = null;
    const unsubscribe = onSocketChange((socket) => {
      off?.();
      off = null;
      if (!socket) return;
      const fn = ((...args: unknown[]) => (ref.current as (...a: unknown[]) => void)(...args)) as never;
      socket.on(event, fn);
      off = () => socket.off(event, fn);
    });
    return () => {
      unsubscribe();
      off?.();
    };
  }, [event]);
}
