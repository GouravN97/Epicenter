// Socket.IO connection to the /dash namespace (plan §7.1, §11).
// One socket per tab, opened after login and closed on logout.
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { NS_DASH, type DashC2S, type DashS2C } from '@epicenter/shared';
import { API_URL, USE_MOCK } from './env';
import { useAuth } from '../state/authStore';

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
  if (USE_MOCK) {
    // The mock is loaded only in mock mode, so it never ships in a real build's main bundle.
    const pending = token;
    void Promise.all([import('../mocks/mockBackend'), import('../mocks/mockApi'), import('../mocks/mockSocket')]).then(([be, apiMod, sockMod]) => {
      if (socket || useAuth.getState().token !== pending) return; // logged out or replaced meanwhile
      const mock = new sockMod.MockSocket(be.getMockBackend(), apiMod.userFromToken(pending), pending);
      (window as unknown as { __epicenterMock?: unknown }).__epicenterMock = mock; // for `drop(ms)` from DevTools
      wire(mock as unknown as DashSocket);
    });
    return;
  }
  wire(io(API_URL + NS_DASH, { transports: ['websocket'], auth: { token }, autoConnect: false }));
}

function wire(s: DashSocket): void {
  s.on('connect', () => setStatus(USE_MOCK ? 'mock' : 'live'));
  s.on('disconnect', (reason) => {
    // After an explicit disconnect (ours or the server's) socket.io does not retry.
    const final = reason === 'io client disconnect' || reason === 'io server disconnect';
    setStatus(final ? 'offline' : 'reconnecting');
  });
  s.on('connect_error', (err: Error) => {
    // The server rejects an expired or revoked token at the handshake: the session is over.
    if (err?.message === 'unauthorized') {
      useAuth.getState().logout();
      return;
    }
    setStatus(s.active ? 'reconnecting' : 'offline');
  });

  setSocket(s);
  s.connect();
}

/**
 * Demo and test helper: `epicenter.drop(15000)` in the browser console drops the live connection for that
 * many milliseconds, then reconnects, so the reconnect gap-fill can be shown. (DevTools' "Offline" switch
 * does not reliably close an open WebSocket.) Works in real and mock mode.
 */
function dropConnection(ms = 15_000): string {
  const s = socket;
  if (!s) return 'Not connected.';
  const mock = s as unknown as { drop?: (ms: number) => void };
  if (USE_MOCK && mock.drop) mock.drop(ms);
  else {
    s.disconnect();
    setTimeout(() => {
      if (socket === s) s.connect();
    }, ms);
  }
  return `Connection dropped; reconnecting in ${Math.round(ms / 1000)} s.`;
}
if (typeof window !== 'undefined') (window as unknown as { epicenter?: unknown }).epicenter = { drop: dropConnection };

export function disconnectSocket(): void {
  const s = socket;
  if (!s) return;
  setSocket(null);
  s.removeAllListeners();
  s.disconnect();
  setStatus('offline');
}
