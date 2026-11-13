// Socket.IO connection to the /dash namespace (plan §7.1, §11).
// One socket per tab, opened after login and closed on logout.
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { NS_DASH, type DashC2S, type DashS2C } from '@epicenter/shared';
import { API_URL, USE_MOCK } from './env';
import { getMockBackend } from '../mocks/mockBackend';
import { userFromToken } from '../mocks/mockApi';
import { MockSocket } from '../mocks/mockSocket';

/** Typed with the shared event maps, so event names and payload shapes are checked at compile time. */
export type DashSocket = Socket<DashS2C, DashC2S>;

export type ConnectionStatus = 'offline' | 'connecting' | 'live' | 'reconnecting' | 'mock';

export const useConnection = create<{ status: ConnectionStatus }>(() => ({ status: 'offline' }));
const setStatus = (status: ConnectionStatus) => useConnection.setState({ status });

let socket: DashSocket | null = null;
const listeners = new Set<(s: DashSocket | null) => void>();

/** The current socket, or null when logged out. In mock mode this is the mock emitter (same surface). */
export function getSocket(): DashSocket | null {
  return socket;
}

/** Calls `fn` now and whenever the socket is replaced (login, logout). Returns an unsubscribe function. */
export function onSocketChange(fn: (s: DashSocket | null) => void): () => void {
  listeners.add(fn);
  fn(socket);
  return () => listeners.delete(fn);
}

function setSocket(s: DashSocket | null): void {
  socket = s;
  for (const fn of listeners) fn(s);
}

export function connectSocket(token: string): void {
  if (socket) {
    if ((socket.auth as { token?: string }).token === token) return;
    disconnectSocket();
  }

  setStatus('connecting');
  let s: DashSocket;
  if (USE_MOCK) {
    const mock = new MockSocket(getMockBackend(), userFromToken(token), token);
    (window as unknown as { __epicenterMock?: MockSocket }).__epicenterMock = mock; // for `drop(ms)` from DevTools
    s = mock as unknown as DashSocket;
  } else {
    s = io(API_URL + NS_DASH, { transports: ['websocket'], auth: { token }, autoConnect: false });
  }

  s.on('connect', () => setStatus(USE_MOCK ? 'mock' : 'live'));
  s.on('disconnect', (reason) => {
    // After an explicit disconnect (ours or the server's) socket.io does not retry.
    const final = reason === 'io client disconnect' || reason === 'io server disconnect';
    setStatus(final ? 'offline' : 'reconnecting');
  });
  s.on('connect_error', () => setStatus(s.active ? 'reconnecting' : 'offline'));

  setSocket(s);
  s.connect();
}

export function disconnectSocket(): void {
  const s = socket;
  if (!s) return;
  setSocket(null);
  s.removeAllListeners();
  s.disconnect();
  setStatus('offline');
}
