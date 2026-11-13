// Broadcaster (plan §8.5). A 1 Hz loop sends fleet:delta per team (changed nodes only), topo:tick and
// meta:pt. node:pt and svc:pt go out as soon as the aggregator finalizes a second. Nothing is serialized for
// a room nobody is in.
import type { Namespace } from 'socket.io';
import {
  BROADCAST_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  NodeStatus,
  SERVICES,
  TEAMS,
  encodeNodePt,
  room,
  type DashC2S,
  type DashS2C,
  type FleetDelta,
  type MetricValues,
  type PipelineStats,
  type ServiceId,
  type SvcPt,
  type Team,
  type TopoTick,
} from '@epicenter/shared';
import type { Point } from '../pipeline/aggregator';
import type { Pipeline } from '../pipeline';
import type { NodeInfo } from '../pipeline/nodeRegistry';
import { FleetDiffer, aggregateService, fleetRow, topoRow, type ServiceAgg } from './snapshots';

export type DashNamespace = Namespace<DashC2S, DashS2C>;

/**
 * Outbound backpressure (§8.4.3). Socket.IO's `volatile` flag drops a packet whenever the websocket is still
 * writing the previous one, which loses all but the first of several points emitted in the same tick. So
 * instead, chart streams (node:pt, svc:pt, meta:pt) skip only sockets whose engine send queue is backed up:
 * a slow browser misses frames (and gap-fills from history) while healthy ones get every point.
 */
const CONGESTED_PACKETS = 64;
const CONGESTION_RECHECK_MS = 200;

export class Broadcaster {
  /** Alert-derived node status (A7 detector plugs in here). Silence is handled separately. */
  alertStatus: (nodeId: string) => NodeStatus = () => NodeStatus.ok;
  /** Builds the pipeline stats snapshot for meta:pt. */
  stats: (() => PipelineStats) | null = null;
  /** Emits in the last completed second. */
  emitsPerSec = 0;

  private readonly differs = new Map<Team, FleetDiffer>(TEAMS.map((t) => [t, new FleetDiffer()]));
  private readonly latestAgg = new Map<ServiceId, ServiceAgg>();
  private pendingSvc = new Map<string, { svc: ServiceId; ts: number; points: MetricValues[] }>();
  private svcFlushQueued = false;
  private teamNodes = new Map<Team, NodeInfo[]>();
  private svcNodes = new Map<ServiceId, NodeInfo[]>();
  private indexedCount = -1;
  private emits = 0;
  /** Bytes sent in the last completed second (payload × recipients). */
  bytesOutPerSec = 0;
  private bytes = 0;
  /** Points not sent to a socket because it was congested, last second. */
  skippedPerSec = 0;
  private skipped = 0;
  private congestedAt = 0;
  private congestedIds: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly nsp: DashNamespace,
    private readonly pipeline: Pipeline,
  ) {}

  start(): void {
    this.pipeline.aggregator.on({ point: (p, correction) => this.onPoint(p, correction) });
    this.tick(); // fill the fleet snapshots so the first subscriber gets every node
    this.timer ??= setInterval(() => this.tick(), BROADCAST_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private occupied(r: string): boolean {
    return (this.nsp.adapter.rooms.get(r)?.size ?? 0) > 0;
  }

  private congested(): string[] {
    const now = Date.now();
    if (now - this.congestedAt > CONGESTION_RECHECK_MS) {
      this.congestedAt = now;
      this.congestedIds = [];
      for (const s of this.nsp.sockets.values()) {
        // engine.io's per-connection outgoing queue. Typed private but a plain field in every 6.x release.
        const queued = (s.conn as unknown as { writeBuffer?: unknown[] }).writeBuffer?.length ?? 0;
        if (queued > CONGESTED_PACKETS) this.congestedIds.push(s.id);
      }
    }
    return this.congestedIds;
  }

  /** Emit to a room, skipping congested sockets. */
  private emitDroppable<E extends 'node:pt' | 'svc:pt' | 'meta:pt'>(r: string, ev: E, ...args: Parameters<DashS2C[E]>): void {
    const skip = this.congested();
    const members = this.nsp.adapter.rooms.get(r);
    let skipped = 0;
    if (skip.length && members) for (const id of skip) if (members.has(id)) skipped++;
    this.skipped += skipped;
    (skip.length ? this.nsp.to(r).except(skip) : this.nsp.to(r)).emit(ev, ...args);
    this.account(ev, args[0], (members?.size ?? 0) - skipped);
  }

  /** Emit to every member of a room. */
  private emitAll<E extends 'fleet:delta' | 'topo:tick'>(r: string, ev: E, ...args: Parameters<DashS2C[E]>): void {
    this.nsp.to(r).emit(ev, ...args);
    this.account(ev, args[0], this.nsp.adapter.rooms.get(r)?.size ?? 0);
  }

  /**
   * bytesOutPerSec (§8.8): encoded payload length × recipients. JSON length approximates the wire size of
   * Socket.IO's default parser (plus a few bytes of framing per packet).
   */
  private account(ev: string, payload: unknown, recipients: number): void {
    this.emits++;
    if (recipients > 0) this.bytes += (JSON.stringify(payload).length + ev.length + 6) * recipients;
  }

  /** Re-indexes nodes by team and service when the registry grows. */
  private indexNodes(): void {
    const list = this.pipeline.registry.list;
    if (list.length === this.indexedCount) return;
    this.teamNodes = new Map(TEAMS.map((t) => [t, []]));
    this.svcNodes = new Map(SERVICES.map((s) => [s.id, []]));
    for (const n of list) {
      this.teamNodes.get(n.team)!.push(n);
      this.svcNodes.get(n.serviceId)!.push(n);
    }
    this.indexedCount = list.length;
  }

  nodeStatus(nodeId: string, now: number): NodeStatus {
    const s = this.pipeline.state.nodes.get(nodeId);
    if (!s || now - s.lastSeen > HEARTBEAT_TIMEOUT_MS) return NodeStatus.silent;
    return this.alertStatus(nodeId);
  }

  /** Full fleet:delta for a team: sent once to a socket right after it joins fleet:<team>. */
  fleetSnapshot(team: Team): FleetDelta {
    return [Math.floor(Date.now() / 1000), ...this.differs.get(team)!.snapshot()];
  }

  private onPoint(p: Point, correction: boolean): void {
    const info = this.pipeline.registry.get(p.nodeId);
    if (!info) return;
    const nr = room.node(p.nodeId);
    if (this.occupied(nr)) this.emitDroppable(nr, 'node:pt', encodeNodePt(info.idx, p.ts, p, p.rev));
    if (correction) return; // service aggregates are built from first emissions only
    const key = `${info.serviceId}|${p.ts}`;
    let g = this.pendingSvc.get(key);
    if (!g) {
      g = { svc: info.serviceId, ts: p.ts, points: [] };
      this.pendingSvc.set(key, g);
    }
    g.points.push(p);
    if (!this.svcFlushQueued) {
      // Every node's bucket for a second finalizes in the same aggregator tick; flush once it has finished.
      this.svcFlushQueued = true;
      queueMicrotask(() => this.flushSvc());
    }
  }

  private flushSvc(): void {
    this.svcFlushQueued = false;
    const groups = this.pendingSvc;
    this.pendingSvc = new Map();
    for (const g of groups.values()) {
      const agg = aggregateService(g.ts, g.points);
      const prev = this.latestAgg.get(g.svc);
      if (!prev || agg.ts >= prev.ts) this.latestAgg.set(g.svc, agg);
      const sr = room.service(g.svc);
      if (this.occupied(sr)) {
        const pt: SvcPt = [SERVICES.find((s) => s.id === g.svc)!.idx, agg.ts, agg.cpuAvg, agg.memAvg, agg.latP95, agg.errAvg, agg.rps];
        this.emitDroppable(sr, 'svc:pt', pt);
      }
    }
  }

  private tick(): void {
    const now = Date.now();
    this.indexNodes();
    const status = new Map<string, NodeStatus>();
    for (const n of this.pipeline.registry.list) status.set(n.nodeId, this.nodeStatus(n.nodeId, now));

    for (const team of TEAMS) {
      const nodes = this.teamNodes.get(team)!;
      const rows = nodes.map((n) => fleetRow(n.idx, this.pipeline.state.nodes.get(n.nodeId)?.last ?? null, status.get(n.nodeId)!));
      // Diff even when nobody listens, so a late joiner's snapshot matches what later deltas assume.
      const changed = this.differs.get(team)!.diff(rows);
      const fr = room.fleet(team);
      if (changed.length && this.occupied(fr)) {
        let ts = 0;
        for (const n of nodes) ts = Math.max(ts, this.pipeline.state.nodes.get(n.nodeId)?.lastTs ?? 0);
        const delta: FleetDelta = [Math.floor((ts || now) / 1000), ...changed];
        this.emitAll(fr, 'fleet:delta', delta);
      }
    }

    if (this.occupied(room.topology)) {
      let ts = 0;
      for (const a of this.latestAgg.values()) ts = Math.max(ts, a.ts);
      const tick: TopoTick = [
        Math.floor((ts || now) / 1000),
        ...SERVICES.map((s) => topoRow(s.idx, this.latestAgg.get(s.id), this.svcNodes.get(s.id)!.map((n) => status.get(n.nodeId)!))),
      ];
      this.emitAll(room.topology, 'topo:tick', tick);
    }

    // Roll the per-second counters before building meta:pt so it reports the second that just completed.
    this.emitsPerSec = this.emits;
    this.emits = 0;
    this.bytesOutPerSec = this.bytes;
    this.bytes = 0;
    if (this.stats && this.occupied(room.meta)) this.emitDroppable(room.meta, 'meta:pt', this.stats());
    this.skippedPerSec = this.skipped;
    this.skipped = 0;
  }
}
