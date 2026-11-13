// Socket.IO connection to the /dash namespace (plan §7.1, §11).
// One socket per tab, opened after login and closed on logout.
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { NS_DASH } from '@epicenter/shared';
import { API_URL, USE_MOCK } from './env';

export type ConnectionStatus = 'offline' | 'connecting' | 'live' | 'reconnecting' | 'mock';

export const useConnection = create<{ status: ConnectionStatus }>(() => ({
  status: USE_MOCK ? 'mock' : 'offline',
}));
const setStatus = (status: ConnectionStatus) => useConnection.setState({ status });

let socket: Socket | null = null;

/** The live socket, or null when logged out or in mock mode (task B2 plugs the mock emitter in here). */
export function getSocket(): Socket | null {
  return socket;
}

export function connectSocket(token: string): void {
  if (USE_MOCK) return;
  if (socket) {
    if (socket.auth && (socket.auth as { token?: string }).token === token) return;
    disconnectSocket();
  }

  setStatus('connecting');
  const s = io(API_URL + NS_DASH, {
    transports: ['websocket'],
    auth: { token },
  });
  socket = s;

  s.on('connect', () => setStatus('live'));
  s.on('disconnect', (reason) => {
    // After an explicit disconnect (ours or the server's) socket.io does not retry.
    const final = reason === 'io client disconnect' || reason === 'io server disconnect';
    setStatus(final ? 'offline' : 'reconnecting');
  });
  s.on('connect_error', () => setStatus(s.active ? 'reconnecting' : 'offline'));
}

export function disconnectSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  setStatus(USE_MOCK ? 'mock' : 'offline');
}
