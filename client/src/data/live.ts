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
  TEAMS,
  type SvcPt,
  type Team,
  type TopoTick,
  type TopologyResponse,
  type UserDTO,
} from '@epicenter/shared';
import { api } from '../lib/api';
import { onSocketChange, type DashSocket } from '../lib/socket';
import { useAlerts } from '../state/alertStore';
import { useAuth } from '../state/authStore';
import { useIncidents } from '../state/incidentStore';
import { Clock } from './clock';
import { FleetState } from './fleetState';
import { Ring } from './ring';
import { RoomManager, type RoomSocket } from './RoomManager';
import type { SeriesDeps } from './seriesSession';
import { TelemetryStore } from './TelemetryStore';
import { TopoState } from './topoState';
import { TopologyRegistry } from './topology';

export const store = new TelemetryStore();
export const rooms = new RoomManager();
export const topology = new TopologyRegistry();
export const fleet = new FleetState();
export const topo = new TopoState();
export const clock = new Clock();
/**
 * Data delay in ms, one sample per fleet:delta: server-clock now − the delta's source second (§9.2).
 * It includes the ~3 s the aggregator waits for late events, so about 3–4 s is healthy.
 */
export const delay = new Ring(60);

/** Draw key for everything that renders from `fleet` (heatmap, stat tiles). */
export const FLEET_KEY = 'fleet';
/** Draw key for everything that renders from `topo`. */
export const TOPO_KEY = 'topology';

/** Teams whose rooms a user may join: admins and SREs see every team (§7.2). */
export function visibleTeams(user: UserDTO | null): Team[] {
  if (!user) return [];
  return user.role === 'viewer' ? user.teams : [...TEAMS];
}

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
  fetchHistory: (roomName, from, to, signal, res) =>
    api.get<ColumnarSeries>(historyPath(roomName), { from: Math.floor(from), to: Math.ceil(to), res }, signal),
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
  delay.push(clock.liveNow() - d[0] * 1000);
  store.markDirty(FLEET_KEY);
}

function onTopoTick(t: TopoTick): void {
  topo.apply(t);
  store.markDirty(TOPO_KEY);
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
    socket.on('topo:tick', onTopoTick);
    socket.on('alert:new', (a) => useAlerts.getState().apply(a, true));
    socket.on('alert:upd', (a) => useAlerts.getState().apply(a, true));
    socket.on('incident:new', (i) => useIncidents.getState().apply(i));
    socket.on('incident:upd', (i) => useIncidents.getState().apply(i));
    socket.on('connect', () => syncClock(socket));
    if (socket.connected) syncClock(socket);
  });

  // Session-scoped data: loaded on login, forgotten on logout.
  let releaseAlertRooms: (() => void)[] = [];
  const onAuth = (status: string) => {
    if (status === 'authed') {
      topology
        .load(() => api.get<TopologyResponse>('/topology'))
        .then(() => fleet.resize(topology.size))
        .catch(() => {
          // Left unloaded: pages show their error state and `reloadTopology` retries.
        });
      // Alerts and incidents are followed on every page (feed, banner, counts), so their rooms are
      // held for the whole session rather than by one component.
      if (!releaseAlertRooms.length) {
        releaseAlertRooms = visibleTeams(useAuth.getState().user).map((t) => rooms.acquire(room.alerts(t)));
      }
      void useAlerts.getState().load();
      void useIncidents.getState().load();
    } else if (status === 'anon') {
      releaseAlertRooms.splice(0).forEach((release) => release());
      topology.reset();
      fleet.reset();
      topo.reset();
      delay.clear();
      useAlerts.getState().reset();
      useIncidents.getState().reset();
      store.markDirty(FLEET_KEY);
      store.markDirty(TOPO_KEY);
    }
  };
  onAuth(useAuth.getState().status);
  useAuth.subscribe((s, prev) => {
    if (s.status !== prev.status) onAuth(s.status);
  });

  // Lifecycle events missed while disconnected are not replayed by the server: reload after a reconnect.
  rooms.onConnection((ev) => {
    if (ev !== 'reconnect') return;
    void useAlerts.getState().load();
    void useIncidents.getState().load();
  });
}

export function reloadTopology(): Promise<void> {
  return topology.load(() => api.get<TopologyResponse>('/topology')).then(() => fleet.resize(topology.size));
}
