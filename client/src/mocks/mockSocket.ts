// Fake /dash socket for mock mode (plan §12.1): the UI can be built before the backend exists.
//
// It behaves like the real connection in the ways the client depends on:
//  - `sub` / `unsub` / `time` / `presence:hello` take ack callbacks and enforce the §7.2 access rule
//  - events are delivered only to rooms this socket joined, in the §7.3 positional-array shapes
//  - the first `fleet:delta` after joining a fleet room carries every node; later ones only changed nodes
//  - a dropped connection loses its rooms, so the client must re-subscribe on `connect` (as with Socket.IO)
import {
  FLEET_DELTA_MIN_CHANGE,
  SOCKET_MAX_ROOMS,
  encodeNodePt,
  room,
  type AlertDTO,
  type DashC2S,
  type DashS2C,
  type FleetDelta,
  type FleetDeltaRow,
  type IncidentDTO,
  type NodeStatus,
  type PresencePayload,
  type PresenceUser,
  type TimelineEntry,
  type SubAck,
  type SubReq,
  type TimeAck,
  type TimeReq,
  type TopoTick,
  type UserDTO,
} from '@epicenter/shared';
import { SERVICE_BY_ID, isServiceId, parseRoom } from '@epicenter/shared';
import { teamsOf, type BackendListener, type MockBackend, type TickFrame } from './mockBackend';

type Handler = (...args: never[]) => void;
type LifecycleEvent = 'connect' | 'disconnect' | 'connect_error';

export interface MockSocketOptions {
  /** Delivery delay in ms. 0 delivers synchronously (used by tests). */
  latencyMs?: number;
}

export class MockSocket implements BackendListener {
  connected = false;
  /** Mirrors Socket.active: true while the socket will (re)connect by itself. */
  active = true;
  readonly auth: { token: string };

  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly rooms = new Set<string>();
  /** Incidents this socket announced itself in. */
  private readonly presenceIn = new Set<string>();
  private readonly latencyMs: number;
  private unsubscribeBackend: (() => void) | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  // Last values sent in fleet:delta, per node. −1 = never sent to this socket.
  private readonly sentCpu: Int16Array;
  private readonly sentMem: Int16Array;
  private readonly sentStatus: Int8Array;

  constructor(
    private readonly backend: MockBackend,
    private readonly user: UserDTO,
    token: string,
    opts: MockSocketOptions = {},
  ) {
    this.auth = { token };
    this.latencyMs = opts.latencyMs ?? 15;
    const n = backend.world.nodes.length;
    this.sentCpu = new Int16Array(n).fill(-1);
    this.sentMem = new Int16Array(n).fill(-1);
    this.sentStatus = new Int8Array(n).fill(-1);
  }

  // ------------------------------------------------------------------ Socket.IO-compatible surface

  on(event: string, fn: Handler): this {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(event: string, fn?: Handler): this {
    if (fn) this.handlers.get(event)?.delete(fn);
    else this.handlers.delete(event);
    return this;
  }

  removeAllListeners(): this {
    this.handlers.clear();
    return this;
  }

  connect(): this {
    if (this.connected) return this;
    this.active = true;
    this.unsubscribeBackend ??= this.backend.subscribe(this);
    this.later(() => {
      this.connected = true;
      this.dispatch('connect');
    });
    return this;
  }

  disconnect(): this {
    this.active = false;
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.goOffline('io client disconnect');
    return this;
  }

  /** Client → server. Mirrors the §7.2 events; anything else is ignored. */
  emit<E extends keyof DashC2S>(event: E, ...args: Parameters<DashC2S[E]>): this {
    if (!this.connected) return this; // a real socket would buffer; the client re-subscribes on connect anyway
    const [payload, ack] = args as [unknown, ((res: unknown) => void) | undefined];
    const reply = (res: unknown) => ack && this.later(() => ack(res));

    switch (event) {
      case 'sub': {
        const before = new Set(this.rooms);
        const res = this.handleSub(payload as SubReq);
        reply(res);
        // §7.3: the ack is followed by one full fleet:delta for each fleet room just joined.
        for (const r of res.joined) {
          const parsed = before.has(r) ? null : parseRoom(r);
          if (parsed?.kind === 'fleet' && this.backend.frame) this.sendFleet(this.backend.frame, parsed.arg, true);
        }
        break;
      }
      case 'unsub':
        for (const r of (payload as SubReq).rooms ?? []) this.leave(r);
        reply({ ok: true });
        break;
      case 'time':
        reply({ t0: (payload as TimeReq).t0, ts: Date.now() } satisfies TimeAck);
        break;
      case 'presence:hello': {
        const id = String((payload as { incidentId?: unknown })?.incidentId ?? '');
        if (!this.rooms.has(room.incident(id))) {
          reply({ users: [] } satisfies PresencePayload);
          break;
        }
        this.presenceIn.add(id);
        reply({ users: this.backend.presenceJoin(id, this, { id: this.user.id, name: this.user.name }) } satisfies PresencePayload);
        break;
      }
      case 'client:stats':
        break;
    }
    return this;
  }

  // ------------------------------------------------------------------ test and demo helpers

  /**
   * Simulates a network drop: `disconnect` now, `connect` after `ms`. Rooms are lost, as on a real
   * reconnect. From DevTools: `__epicenterMock.drop(20000)`.
   */
  drop(ms: number): void {
    this.down();
    this.later(() => this.up(), Math.max(1, ms));
  }

  /** The connection goes away (`disconnect` with reason "transport close"). */
  down(): void {
    if (this.connected) this.goOffline('transport close');
  }

  /** The connection comes back (`connect`), with no rooms joined. */
  up(): void {
    if (this.connected || !this.active) return;
    this.connected = true;
    this.dispatch('connect');
  }

  joinedRooms(): string[] {
    return [...this.rooms];
  }

  // ------------------------------------------------------------------ rooms

  private handleSub(req: SubReq): SubAck {
    const joined: string[] = [];
    const denied: string[] = [];
    const requested = (req?.rooms ?? []).flatMap((r) => (r === room.fleetAll ? teamsOf(this.user).map((t) => room.fleet(t)) : [r]));

    for (const r of requested) {
      if (this.rooms.has(r)) {
        joined.push(r);
      } else if (this.rooms.size < SOCKET_MAX_ROOMS && this.backend.canJoin(this.user, r)) {
        this.rooms.add(r);
        joined.push(r);
      } else {
        denied.push(r);
      }
    }
    return { joined, denied };
  }

  private leave(r: string): void {
    if (!this.rooms.delete(r)) return;
    const parsed = parseRoom(r);
    if (parsed?.kind === 'fleet') this.forgetFleet(parsed.arg);
    if (parsed?.kind === 'incident' && this.presenceIn.delete(parsed.arg)) this.backend.presenceLeave(parsed.arg, this);
  }

  private forgetFleet(team: string): void {
    for (const n of this.backend.world.nodes) {
      if (n.team !== team) continue;
      this.sentCpu[n.idx] = -1;
      this.sentMem[n.idx] = -1;
      this.sentStatus[n.idx] = -1;
    }
  }

  private goOffline(reason: string): void {
    const was = this.connected;
    this.connected = false;
    this.rooms.clear();
    for (const id of this.presenceIn) this.backend.presenceLeave(id, this);
    this.presenceIn.clear();
    this.sentCpu.fill(-1);
    this.sentMem.fill(-1);
    this.sentStatus.fill(-1);
    if (was) this.dispatch('disconnect', reason);
  }

  // ------------------------------------------------------------------ backend → rooms

  onTick(frame: TickFrame): void {
    if (!this.connected || this.rooms.size === 0) return;
    const { world } = this.backend;

    for (const r of this.rooms) {
      const parsed = parseRoom(r);
      if (!parsed) continue;
      switch (parsed.kind) {
        case 'fleet':
          this.sendFleet(frame, parsed.arg, false);
          break;
        case 'topology':
          this.send('topo:tick', [frame.tSec, ...frame.topoRows.map((row) => [...row])] as TopoTick);
          break;
        case 'node': {
          const node = world.nodeById.get(parsed.arg);
          const p = node && frame.points[node.idx];
          if (node && p) this.send('node:pt', encodeNodePt(node.idx, frame.tSec * 1000, p, 0));
          break;
        }
        case 'service': {
          if (isServiceId(parsed.arg)) this.send('svc:pt', [...frame.svcPts[SERVICE_BY_ID[parsed.arg].idx]!]);
          break;
        }
        case 'meta':
          this.send('meta:pt', { ...frame.stats });
          break;
      }
    }
  }

  /** `full` sends every node of the team; otherwise only nodes that moved ≥ 1 point or changed status. */
  private sendFleet(frame: TickFrame, team: string, full: boolean): void {
    const rows: FleetDeltaRow[] = [];
    for (const n of this.backend.world.nodes) {
      if (n.team !== team) continue;
      const i = n.idx;
      const p = frame.points[i];
      const status = frame.status[i] as NodeStatus;
      // A silent node keeps its last known values and only changes status.
      const cpu = p ? Math.round(p.cpu) : Math.max(0, this.sentCpu[i]!);
      const mem = p ? Math.round(p.mem) : Math.max(0, this.sentMem[i]!);
      const changed =
        full ||
        this.sentStatus[i] !== status ||
        Math.abs(cpu - this.sentCpu[i]!) >= FLEET_DELTA_MIN_CHANGE ||
        Math.abs(mem - this.sentMem[i]!) >= FLEET_DELTA_MIN_CHANGE;
      if (!changed) continue;
      this.sentCpu[i] = cpu;
      this.sentMem[i] = mem;
      this.sentStatus[i] = status;
      rows.push([i, cpu, mem, status]);
    }
    if (rows.length) this.send('fleet:delta', [frame.tSec, ...rows] as FleetDelta);
  }

  onNote(incidentId: string, entry: TimelineEntry): void {
    if (this.connected && this.rooms.has(room.incident(incidentId))) this.send('incident:note', entry);
  }

  onPresence(incidentId: string, users: PresenceUser[]): void {
    if (this.connected && this.rooms.has(room.incident(incidentId))) this.send('presence', { users });
  }

  onAlert(kind: 'new' | 'upd', alert: AlertDTO): void {
    if (this.connected && this.rooms.has(room.alerts(alert.team))) this.send(kind === 'new' ? 'alert:new' : 'alert:upd', alert);
  }

  onIncident(kind: 'new' | 'upd', incident: IncidentDTO): void {
    if (!this.connected) return;
    const teams = new Set(incident.affected.filter(isServiceId).map((s) => SERVICE_BY_ID[s].team));
    const viaTeam = [...teams].some((t) => this.rooms.has(room.alerts(t)));
    // One delivery even when the socket is in several matching rooms, as Socket.IO does for a multi-room emit.
    if (viaTeam || this.rooms.has(room.incident(incident.id))) this.send(kind === 'new' ? 'incident:new' : 'incident:upd', incident);
  }

  // ------------------------------------------------------------------ plumbing

  private send<E extends keyof DashS2C>(event: E, ...args: Parameters<DashS2C[E]>): void {
    this.later(() => {
      if (this.connected) this.dispatch(event, ...args);
    });
  }

  private dispatch(event: keyof DashS2C | LifecycleEvent, ...args: unknown[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) (fn as (...a: unknown[]) => void)(...args);
  }

  private later(fn: () => void, ms = this.latencyMs): void {
    if (ms <= 0) return fn();
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
}
