// Socket.IO server and the /dash namespace (plan §7). JWT in handshake.auth.token, verified once at connect.
import type http from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  NS_DASH,
  SOCKET_MAX_ROOMS,
  parseRoom,
  room,
  type AlertDTO,
  type AuthClaims,
  type ChaosActiveRun,
  type ClientStats,
  type DashC2S,
  type DashS2C,
  type PipelineStats,
  type Team,
} from '@epicenter/shared';
import { config } from '../config';
import { verifyToken } from '../lib/jwt';
import type { Pipeline } from '../pipeline';
import { Broadcaster } from './broadcaster';
import { CallLimiter, expandRooms, planSub, type RoomContext } from './rooms';

interface SocketData {
  user: AuthClaims;
  limiter: CallLimiter;
  clientStats?: ClientStats & { at: number };
}
type DashSocket = Socket<DashC2S, DashS2C, Record<string, never>, SocketData>;

export interface Realtime {
  io: Server;
  broadcaster: Broadcaster;
  /** Incident → teams lookup for incident:<id> rooms (A9 sets it). */
  setIncidentTeams(fn: (id: string) => Team[] | undefined): void;
  /** Broadcasts the active chaos runs to the meta room. */
  emitChaos(active: ChaosActiveRun[]): void;
  /** Current active chaos runs, sent to each socket right after it joins meta. */
  setChaosSnapshot(fn: () => ChaosActiveRun[]): void;
  /** Sends an alert event to the alerts:<team> room of the alert's team. */
  emitAlert(event: 'alert:new' | 'alert:upd', a: AlertDTO): void;
  /** Dashboard sockets and their latest client:stats. */
  dashStats(): { sockets: number; rooms: number; clientE2eP95: number[] };
  close(): Promise<void>;
}

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function createRealtime(server: http.Server, pipeline: Pipeline, stats?: () => PipelineStats): Realtime {
  const io = new Server(server, {
    cors: { origin: config.clientOrigin },
    serveClient: false,
    maxHttpBufferSize: 16 * 1024, // clients only send small control messages
  });
  // Nothing lives on the default namespace.
  io.of('/').use((_s, next) => next(new Error('use the /dash or /control namespace')));

  const dash = io.of(NS_DASH);
  const broadcaster = new Broadcaster(dash, pipeline);
  if (stats) broadcaster.stats = stats;

  let incidentTeams: (id: string) => Team[] | undefined = () => undefined;
  let chaosSnapshot: () => ChaosActiveRun[] = () => [];
  const ctx: RoomContext = {
    nodeTeam: (id) => pipeline.registry.get(id)?.team,
    incidentTeams: (id) => incidentTeams(id),
  };

  dash.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    try {
      if (typeof token !== 'string' || !token) throw new Error('missing token');
      socket.data.user = verifyToken(token, config.jwtSecret);
      socket.data.limiter = new CallLimiter();
      next();
    } catch {
      next(Object.assign(new Error('unauthorized'), { data: { code: 'unauthorized' } }));
    }
  });

  dash.on('connection', (raw) => {
    const socket = raw as DashSocket;
    const user = socket.data.user;
    const joinedRooms = () => new Set([...socket.rooms].filter((r) => r !== socket.id));

    socket.on('sub', (req, ack) => {
      if (typeof ack !== 'function') return;
      const rooms = expandRooms(user, req?.rooms).slice(0, SOCKET_MAX_ROOMS);
      if (!socket.data.limiter.allow(Date.now())) return ack({ joined: [], denied: rooms });
      const before = joinedRooms();
      const plan = planSub(user, rooms, before, ctx);
      const fresh = plan.joined.filter((r) => !before.has(r));
      if (fresh.length) socket.join(fresh);
      ack(plan);
      // A new fleet subscriber gets one full snapshot; everything after that is deltas.
      for (const r of fresh) {
        const p = parseRoom(r);
        if (p?.kind === 'fleet') socket.emit('fleet:delta', broadcaster.fleetSnapshot(p.arg as Team));
        if (p?.kind === 'meta') socket.emit('chaos:upd', { active: chaosSnapshot() });
      }
    });

    socket.on('unsub', (req, ack) => {
      const rooms = Array.isArray(req?.rooms) ? expandRooms(user, req.rooms) : [];
      if (socket.data.limiter.allow(Date.now())) for (const r of rooms) if (r !== socket.id) void socket.leave(r);
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('time', (req, ack) => {
      if (typeof ack === 'function') ack({ t0: isFiniteNum(req?.t0) ? req.t0 : 0, ts: Date.now() });
    });

    socket.on('client:stats', (s) => {
      if (s && isFiniteNum(s.e2eP50) && isFiniteNum(s.e2eP95) && isFiniteNum(s.fps)) {
        socket.data.clientStats = { e2eP50: s.e2eP50, e2eP95: s.e2eP95, fps: s.fps, at: Date.now() };
      }
    });

    // Presence is task A9; answer so clients do not wait on the ack.
    socket.on('presence:hello', (_req, ack) => {
      if (typeof ack === 'function') ack({ users: [] });
    });
  });

  return {
    io,
    broadcaster,
    setIncidentTeams(fn) {
      incidentTeams = fn;
    },
    emitChaos(active) {
      dash.to(room.meta).emit('chaos:upd', { active });
    },
    setChaosSnapshot(fn) {
      chaosSnapshot = fn;
    },
    emitAlert(event, a) {
      dash.to(room.alerts(a.team)).emit(event, a);
    },
    dashStats() {
      const sockets = [...dash.sockets.values()] as DashSocket[];
      const fresh = Date.now() - 15_000;
      return {
        sockets: sockets.length,
        rooms: [...dash.adapter.rooms.keys()].filter((r) => !dash.sockets.has(r)).length,
        clientE2eP95: sockets.flatMap((s) => (s.data.clientStats && s.data.clientStats.at > fresh ? [s.data.clientStats.e2eP95] : [])),
      };
    },
    async close() {
      broadcaster.stop();
      await io.close();
    },
  };
}
