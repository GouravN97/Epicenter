// The live data layer: one store, one room manager, one topology, one fleet state, one clock, wired to
// the socket and the session. `initDataLayer()` is called once at start-up.
import {
  METRICS,
  NODE_PT_METRIC0,
  NP,
  SERVICES,
  SP,
  parseRoom,
  room,
  type ColumnarSeries,
  type FleetDelta,
  type NodePt,
  type SvcPt,
  type TopologyResponse,
} from '@epicenter/shared';
import { api } from '../lib/api';
import { onSocketChange, type DashSocket } from '../lib/socket';
import { useAuth } from '../state/authStore';
import { Clock } from './clock';
import { FleetState } from './fleetState';
import { RoomManager, type RoomSocket } from './RoomManager';
import type { SeriesDeps } from './seriesSession';
import { TelemetryStore } from './TelemetryStore';
import { TopologyRegistry } from './topology';

export const store = new TelemetryStore();
export const rooms = new RoomManager();
export const topology = new TopologyRegistry();
export const fleet = new FleetState();
export const clock = new Clock();

/** Draw key for everything that renders from `fleet` (heatmap, stat tiles). */
export const FLEET_KEY = 'fleet';

function historyPath(roomName: string): string {
  const r = parseRoom(roomName);
  if (r?.kind === 'node') return `/metrics/node/${encodeURIComponent(r.arg)}`;
  if (r?.kind === 'service') return `/metrics/service/${encodeURIComponent(r.arg)}`;
  throw new Error(`No history for room "${roomName}"`);
}

/** Dependencies for `openSeries` bound to the live singletons. */
export const seriesDeps: SeriesDeps = {
  store,
  rooms,
  fetchHistory: (roomName, from, to, signal) =>
    api.get<ColumnarSeries>(historyPath(roomName), { from: Math.floor(from), to: Math.ceil(to), res: 'auto' }, signal),
  now: () => clock.liveNow(),
  ready: () => topology.ready(),
};

// ---------------------------------------------------------------------- socket → store

const svcRoomByIdx = SERVICES.map((s) => room.service(s.id));
// svc:pt carries five of the eight metric columns; the rest stay NaN (no data) in a service buffer.
const svcRow = new Float64Array(METRICS.length).fill(NaN);
const COL = Object.fromEntries(METRICS.map((m, i) => [m, i])) as Record<(typeof METRICS)[number], number>;

function onNodePt(p: NodePt): void {
  const key = topology.nodeRoomByIdx[p[NP.nodeIdx]];
  if (key) store.upsert(key, p[NP.ts], p, NODE_PT_METRIC0, p[NP.rev]);
}

function onSvcPt(p: SvcPt): void {
  const key = svcRoomByIdx[p[SP.svcIdx]];
  if (!key) return;
  svcRow[COL.cpu] = p[SP.cpuAvg];
  svcRow[COL.mem] = p[SP.memAvg];
  svcRow[COL.lat] = p[SP.latP95];
  svcRow[COL.err] = p[SP.errAvg];
  svcRow[COL.rps] = p[SP.rps];
  store.upsert(key, p[SP.ts], svcRow);
}

function onFleetDelta(d: FleetDelta): void {
  fleet.apply(d);
  store.markDirty(FLEET_KEY);
}

/** Three `time` round trips; the clock keeps the one with the shortest round trip. */
function syncClock(socket: DashSocket): void {
  clock.resetSync();
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      if (!socket.connected) return;
      const t0 = Date.now();
      socket.emit('time', { t0 }, (ack) => clock.addTimeSample(t0, ack.ts, Date.now()));
    }, i * 400);
  }
}

let started = false;

export function initDataLayer(): void {
  if (started) return;
  started = true;

  onSocketChange((socket) => {
    rooms.attach(socket as unknown as RoomSocket | null);
    if (!socket) return;
    socket.on('node:pt', onNodePt);
    socket.on('svc:pt', onSvcPt);
    socket.on('fleet:delta', onFleetDelta);
    socket.on('connect', () => syncClock(socket));
    if (socket.connected) syncClock(socket);
  });

  // The topology belongs to the session: load it on login, forget it (and the fleet) on logout.
  const onAuth = (status: string) => {
    if (status === 'authed') {
      topology
        .load(() => api.get<TopologyResponse>('/topology'))
        .then(() => fleet.resize(topology.size))
        .catch(() => {
          // Left unloaded: pages show their error state and `reloadTopology` retries.
        });
    } else if (status === 'anon') {
      topology.reset();
      fleet.reset();
      store.markDirty(FLEET_KEY);
    }
  };
  onAuth(useAuth.getState().status);
  useAuth.subscribe((s, prev) => {
    if (s.status !== prev.status) onAuth(s.status);
  });
}

export function reloadTopology(): Promise<void> {
  return topology.load(() => api.get<TopologyResponse>('/topology')).then(() => fleet.resize(topology.size));
}
