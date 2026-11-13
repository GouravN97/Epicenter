// /control namespace (plan §7.1): simulators connect with SIM_KEY in handshake.auth.key; the server pushes
// chaos commands to them. Simulators send nothing (ControlC2S is empty).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Namespace, Server } from 'socket.io';
import { CONTROL, NS_CONTROL, type ChaosCommand, type ControlC2S, type ControlS2C } from '@epicenter/shared';

export type ControlNamespace = Namespace<ControlC2S, ControlS2C>;

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time comparison (hashing first makes the lengths equal). */
export const keyMatches = (given: unknown, expected: string): boolean =>
  typeof given === 'string' && expected.length > 0 && timingSafeEqual(digest(given), digest(expected));

export interface Control {
  nsp: ControlNamespace;
  simulators(): number;
  start(cmd: ChaosCommand): void;
  stop(runId?: string): void;
  /** Called with each newly connected simulator so it can be told about runs already in progress. */
  onSimulatorConnect(fn: (send: (cmd: ChaosCommand) => void) => void): void;
}

export function createControl(io: Server, simKey: string): Control {
  const nsp: ControlNamespace = io.of(NS_CONTROL);
  const connectFns: ((send: (cmd: ChaosCommand) => void) => void)[] = [];

  nsp.use((socket, next) => {
    const key = (socket.handshake.auth as { key?: unknown } | undefined)?.key;
    if (keyMatches(key, simKey)) next();
    else next(Object.assign(new Error('unauthorized'), { data: { code: 'unauthorized' } }));
  });

  nsp.on('connection', (socket) => {
    console.log(`[control] simulator connected (${nsp.sockets.size} total)`);
    for (const fn of connectFns) fn((cmd) => socket.emit(CONTROL.chaosStart, cmd));
    socket.on('disconnect', () => console.log(`[control] simulator disconnected (${nsp.sockets.size} total)`));
  });

  return {
    nsp,
    simulators: () => nsp.sockets.size,
    start: (cmd) => void nsp.emit(CONTROL.chaosStart, cmd),
    stop: (runId) => void nsp.emit(CONTROL.chaosStop, runId ? { runId } : {}),
    onSimulatorConnect: (fn) => void connectFns.push(fn),
  };
}
