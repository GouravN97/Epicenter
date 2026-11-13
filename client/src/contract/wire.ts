// Socket.IO contract (plan §7): namespaces, event names, room helpers and positional tuple layouts.
import type { MetricName, NodeStatus } from './constants';
import type { AlertDTO, ChaosScenarioId, IncidentDTO, TimelineEntry } from './schemas';
import type { RegionId, ServiceId, Team } from './topology';

// ---------------------------------------------------------------- namespaces

export const NS_DASH = '/dash';
export const NS_CONTROL = '/control';

// ---------------------------------------------------------------- event names

/** Client → server on /dash. All take an ack callback except client:stats. */
export const C2S = {
  sub: 'sub',
  unsub: 'unsub',
  time: 'time',
  clientStats: 'client:stats',
  presenceHello: 'presence:hello',
} as const;

/** Server → client on /dash. */
export const S2C = {
  fleetDelta: 'fleet:delta',
  topoTick: 'topo:tick',
  nodePt: 'node:pt',
  svcPt: 'svc:pt',
  alertNew: 'alert:new',
  alertUpd: 'alert:upd',
  incidentNew: 'incident:new',
  incidentUpd: 'incident:upd',
  incidentNote: 'incident:note',
  presence: 'presence',
  metaPt: 'meta:pt',
  chaosUpd: 'chaos:upd',
} as const;

/** Server → simulator on /control. */
export const CONTROL = {
  chaosStart: 'chaos:start',
  chaosStop: 'chaos:stop',
} as const;

// ---------------------------------------------------------------- rooms (§7.1)

export const room = {
  fleet: (team: Team | string) => `fleet:${team}`,
  /** Shorthand accepted by `sub`: expands to the user's permitted fleet:<team> rooms. */
  fleetAll: 'fleet:*',
  topology: 'topology',
  node: (nodeId: string) => `node:${nodeId}`,
  service: (serviceId: ServiceId | string) => `service:${serviceId}`,
  alerts: (team: Team | string) => `alerts:${team}`,
  incident: (id: string) => `incident:${id}`,
  meta: 'meta',
} as const;

export type RoomKind = 'fleet' | 'topology' | 'node' | 'service' | 'alerts' | 'incident' | 'meta';
export interface ParsedRoom {
  kind: RoomKind;
  /** team, nodeId, serviceId or incident id; empty for topology and meta. */
  arg: string;
}

/** Parses a room name. Returns null for anything not in §7.1. */
export function parseRoom(name: string): ParsedRoom | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return null;
  if (name === 'topology' || name === 'meta') return { kind: name, arg: '' };
  const i = name.indexOf(':');
  if (i <= 0) return null;
  const kind = name.slice(0, i);
  const arg = name.slice(i + 1);
  if (!arg) return null;
  switch (kind) {
    case 'fleet':
    case 'node':
    case 'service':
    case 'alerts':
    case 'incident':
      return { kind, arg };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- tuple layouts (§7.3)
// Positional arrays, not objects. Node and service ids are sent once in GET /topology; after that the wire
// uses integer indexes into those lists (nodeIdx is server-assigned, svcIdx = SERVICES order).

/** One row of fleet:delta: [nodeIdx, cpu, mem, status]. Values are rounded integers. */
export type FleetDeltaRow = [nodeIdx: number, cpu: number, mem: number, status: NodeStatus];
/** fleet:delta payload: [tsSec, row, row, …]. Only changed nodes, except the first delta after sub (all nodes). */
export type FleetDelta = [tsSec: number, ...rows: FleetDeltaRow[]];
export const FD = { nodeIdx: 0, cpu: 1, mem: 2, status: 3 } as const;

/** One row of topo:tick. */
export type TopoTickRow = [
  svcIdx: number,
  cpuAvg: number,
  latP95: number,
  errAvg: number,
  rps: number,
  healthyNodes: number,
  totalNodes: number,
  status: NodeStatus,
];
export type TopoTick = [tsSec: number, ...rows: TopoTickRow[]];
export const TT = { svcIdx: 0, cpuAvg: 1, latP95: 2, errAvg: 3, rps: 4, healthy: 5, total: 6, status: 7 } as const;

/**
 * node:pt payload: [nodeIdx, ts, cpu, mem, disk, netIn, netOut, lat, err, rps, rev].
 * ts is epoch ms of the bucket. Metric values have one decimal place. Metrics follow METRICS order.
 */
export type NodePt = [
  nodeIdx: number,
  ts: number,
  cpu: number,
  mem: number,
  disk: number,
  netIn: number,
  netOut: number,
  lat: number,
  err: number,
  rps: number,
  rev: number,
];
/** Index of the first metric in NodePt; metric i of METRICS is at NODE_PT_METRIC0 + i. */
export const NODE_PT_METRIC0 = 2;
export const NP = { nodeIdx: 0, ts: 1, rev: 10 } as const;

/** svc:pt payload: [svcIdx, ts, cpuAvg, memAvg, latP95, errAvg, rps]. */
export type SvcPt = [svcIdx: number, ts: number, cpuAvg: number, memAvg: number, latP95: number, errAvg: number, rps: number];
export const SP = { svcIdx: 0, ts: 1, cpuAvg: 2, memAvg: 3, latP95: 4, errAvg: 5, rps: 6 } as const;

export const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Builds a node:pt tuple from a point (rounds metrics to one decimal place). */
export function encodeNodePt(nodeIdx: number, ts: number, m: Record<MetricName, number>, rev: number): NodePt {
  return [
    nodeIdx,
    ts,
    round1(m.cpu),
    round1(m.mem),
    round1(m.disk),
    round1(m.netIn),
    round1(m.netOut),
    round1(m.lat),
    round1(m.err),
    round1(m.rps),
    rev,
  ];
}

// ---------------------------------------------------------------- object payloads

export interface SubReq {
  rooms: string[];
}
export interface SubAck {
  joined: string[];
  denied: string[];
}
export interface TimeReq {
  t0: number;
}
export interface TimeAck {
  t0: number;
  /** Server epoch ms. */
  ts: number;
}
export interface ClientStats {
  e2eP50: number;
  e2eP95: number;
  fps: number;
}
export interface PresenceUser {
  id: string;
  name: string;
}
export interface PresencePayload {
  users: PresenceUser[];
}
export interface IncidentNotePayload extends TimelineEntry {}
export interface ChaosActiveRun {
  runId: string;
  scenario: ChaosScenarioId;
  target: string | null;
  endsAt: number;
}
export interface ChaosUpd {
  active: ChaosActiveRun[];
}

/** Pipeline stats (§8.8): emitted as meta:pt and served at GET /meta/stats. Counters are per second. */
export interface PipelineStats {
  ts: number;
  eps: number;
  accepted: number;
  duplicate: number;
  outOfOrder: number;
  lateCorrected: number;
  stale: number;
  rejected: number;
  shed429: number;
  bucketsOpen: number;
  writeBatch: number;
  writeMs: number;
  writeBuffer: number;
  writeDropped: number;
  socketsDash: number;
  rooms: number;
  emitsPerSec: number;
  bytesOutPerSec: number;
  loopLagP99: number;
  rssMb: number;
  clientE2eP95: number;
  shedding: boolean;
}

// ---------------------------------------------------------------- GET /topology (§6.2)

/** Node list entry: [nodeIdx, nodeId, serviceId, region, az]. nodeIdx is the index used on the wire. */
export type TopologyNode = [nodeIdx: number, nodeId: string, serviceId: string, region: string, az: string];

export interface TopologyResponse {
  services: { idx: number; id: ServiceId; name: string; team: Team; sloMs: number; layer: number; dependsOn: ServiceId[] }[];
  edges: { from: ServiceId; to: ServiceId; callFraction: number }[];
  teams: Team[];
  regions: RegionId[];
  /** Filtered by the user's teams. Indexes are global, so they may not be contiguous for a viewer. */
  nodes: TopologyNode[];
}

// ---------------------------------------------------------------- typed Socket.IO maps
// Usage: new Server<DashC2S, DashS2C>() / io<DashS2C, DashC2S>() (client).

type Ack<T> = (res: T) => void;

export interface DashC2S {
  sub: (req: SubReq, ack: Ack<SubAck>) => void;
  unsub: (req: SubReq, ack: Ack<{ ok: true }>) => void;
  time: (req: TimeReq, ack: Ack<TimeAck>) => void;
  'client:stats': (stats: ClientStats) => void;
  'presence:hello': (req: { incidentId: string }, ack: Ack<PresencePayload>) => void;
}

export interface DashS2C {
  'fleet:delta': (d: FleetDelta) => void;
  'topo:tick': (t: TopoTick) => void;
  'node:pt': (p: NodePt) => void;
  'svc:pt': (p: SvcPt) => void;
  'alert:new': (a: AlertDTO) => void;
  'alert:upd': (a: AlertDTO) => void;
  'incident:new': (i: IncidentDTO) => void;
  'incident:upd': (i: IncidentDTO) => void;
  'incident:note': (n: IncidentNotePayload) => void;
  presence: (p: PresencePayload) => void;
  'meta:pt': (s: PipelineStats) => void;
  'chaos:upd': (c: ChaosUpd) => void;
}

export interface ChaosCommand {
  runId: string;
  scenario: ChaosScenarioId;
  /** nodeId or serviceId, depending on the scenario's targetKind. */
  target: string | null;
  durationSec: number;
  endsAt: number;
}

export interface ControlS2C {
  'chaos:start': (cmd: ChaosCommand) => void;
  /** No runId → stop everything. */
  'chaos:stop': (req: { runId?: string }) => void;
}
export interface ControlC2S {}
