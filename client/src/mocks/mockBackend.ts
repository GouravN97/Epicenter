// Stand-in for the server in mock mode: ticks the mock world once per second, runs a simplified detector
// and the §8.7 correlator, and answers the REST queries the client makes. mockSocket.ts turns its ticks
// into §7.3 socket events; mockApi.ts routes REST calls here.
//
// The detector is deliberately simpler than the real one (§8.6): it compares each point with the same
// instant computed without the fault. The payload shapes are the real ones, which is what the UI needs.
import {
  ALERTS_PAGE_DEFAULT,
  CHAOS_SCENARIOS,
  CHAOS_LINK_WINDOW_MS,
  REPLAY_MAX_RANGE_MS,
  AUTO_1S_MAX_RANGE_MS,
  EDGES,
  HEARTBEAT_TIMEOUT_MS,
  HISTORY_MAX_POINTS,
  INCIDENT_JOIN_WINDOW_MS,
  INCIDENT_RESOLVE_QUIET_MS,
  METRICS,
  METRIC_UNITS,
  MIN_DELTA,
  NodeStatus,
  REGIONS,
  RESOLVE_STREAK,
  SERVICES,
  SERVICE_BY_ID,
  TEAMS,
  ZSCORE_STREAK,
  isServiceId,
  neighbours,
  parseRoom,
  round1,
  transitiveDependents,
  transitiveDeps,
  type AlertDTO,
  type ColumnarSeries,
  type IncidentDTO,
  type IncidentDetailDTO,
  type ChaosActiveRun,
  type ChaosScenarioDef,
  type ChaosScenarioId,
  type ChaosStartBody,
  type ChaosUpd,
  type ChaosScorecard,
  type MetricValues,
  type NodeSeriesResponse,
  type PresenceUser,
  type ReplayResponse,
  type PipelineStats,
  type ServiceId,
  type ServiceSeriesResponse,
  type SvcPt,
  type Team,
  type TimelineEntry,
  type TopoTickRow,
  type TopologyResponse,
  type UserDTO,
} from '@epicenter/shared';
import { createMockWorld, type MockNode, type MockWorld } from './mockWorld';

/** Live data runs this far behind the wall clock, like the real aggregator's grace period (§8.2). */
export const MOCK_LAG_SEC = 3;
/** Seconds of the past simulated at start-up so alerts and incidents exist on first load. */
const WARMUP_SEC = 600;
const WATCHED: readonly ('cpu' | 'mem' | 'lat' | 'err')[] = ['cpu', 'mem', 'lat', 'err'];
/** Most chaos runs that may be active at once. */
const MAX_ACTIVE_RUNS = 5;

export interface TickFrame {
  tSec: number;
  /** Indexed by nodeIdx; null when the node did not report. */
  points: (MetricValues | null)[];
  /** NodeStatus per node. */
  status: Uint8Array;
  topoRows: TopoTickRow[];
  svcPts: SvcPt[];
  stats: PipelineStats;
}

export interface BackendListener {
  onTick(frame: TickFrame): void;
  onAlert(kind: 'new' | 'upd', alert: AlertDTO): void;
  onIncident(kind: 'new' | 'upd', incident: IncidentDTO): void;
  onNote?(incidentId: string, entry: TimelineEntry): void;
  onPresence?(incidentId: string, users: PresenceUser[]): void;
  onChaos?(upd: ChaosUpd): void;
}

interface ChaosRunRec {
  runId: string;
  scenario: ChaosScenarioId;
  /** nodeId, serviceId or null, as the client sent it. */
  target: string | null;
  /** The service a correct detection should name; null for fleet-wide scenarios. */
  expected: ServiceId | null;
  startedAt: number;
  endsAt: number;
  endedAt: number | null;
  startedBy: string;
}

interface IncidentRec {
  dto: IncidentDTO;
  lastAlertAt: number;
  alertIds: Set<string>;
  onset: Map<string, number>;
  quietSince: number | null;
  timeline: TimelineEntry[];
}

export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Teams whose data a user may see: admins and SREs see everything (§7.2). */
export function teamsOf(user: UserDTO): Team[] {
  return user.role === 'viewer' ? user.teams : [...TEAMS];
}

let idCounter = 0;
const newId = (): string => (++idCounter).toString(16).padStart(24, '0');

export class MockBackend {
  readonly world: MockWorld;
  private readonly now: () => number;
  private readonly listeners = new Set<BackendListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Last processed second. History is served up to and including this. */
  cursor = 0;
  frame: TickFrame | null = null;

  private readonly status: Uint8Array;
  private readonly lastSeen: Float64Array;
  private readonly streak: Uint16Array;
  private readonly okStreak: Uint16Array;
  private readonly firing = new Map<string, AlertDTO>();
  private alertLog: AlertDTO[] = [];
  private incidents: IncidentRec[] = [];

  constructor(opts: { nodes?: number; now?: () => number } = {}) {
    this.world = createMockWorld(opts.nodes);
    this.now = opts.now ?? Date.now;
    const n = this.world.nodes.length;
    this.status = new Uint8Array(n);
    this.lastSeen = new Float64Array(n);
    this.streak = new Uint16Array(n * WATCHED.length);
    this.okStreak = new Uint16Array(n * WATCHED.length);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Simulates the recent past, then ticks in real time. Safe to call more than once. */
  start(): void {
    if (this.timer) return;
    this.advance();
    this.timer = setInterval(() => this.advance(), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(l: BackendListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Processes every second up to `now − lag`. Exposed so tests can drive time themselves. */
  advance(): void {
    const target = Math.floor(this.now() / 1000) - MOCK_LAG_SEC;
    if (this.cursor === 0 || target - this.cursor > WARMUP_SEC) {
      this.cursor = target - WARMUP_SEC;
      this.lastSeen.fill(this.cursor);
    }
    while (this.cursor < target) this.tick(++this.cursor);
  }

  // ------------------------------------------------------------------ one second

  private tick(tSec: number): void {
    const { world } = this;
    const n = world.nodes.length;
    const faulty = world.faultsAt(tSec).length > 0;
    const points: (MetricValues | null)[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const node = world.nodes[i]!;
      const p = world.pointAt(i, tSec);
      points[i] = p;
      const hbKey = `${node.nodeId}|heartbeat|heartbeat`;

      if (!p) {
        if ((tSec - this.lastSeen[i]!) * 1000 > HEARTBEAT_TIMEOUT_MS && !this.firing.has(hbKey)) {
          this.fire(tSec, node, hbKey, 'heartbeat', 'heartbeat', 'crit', 0, HEARTBEAT_TIMEOUT_MS / 1000, `${node.nodeId} stopped reporting`);
        }
        continue;
      }
      this.lastSeen[i] = tSec;
      if (this.firing.has(hbKey)) this.resolve(tSec, hbKey);

      const base = faulty ? world.pointAt(i, tSec, false)! : p;
      for (let k = 0; k < WATCHED.length; k++) {
        const metric = WATCHED[k]!;
        const j = i * WATCHED.length + k;
        const key = `${node.nodeId}|${metric}|zscore`;
        const hit = p[metric] - base[metric] > MIN_DELTA[metric];
        if (hit) {
          this.okStreak[j] = 0;
          if (this.streak[j]! < 0xffff) this.streak[j]!++;
          if (this.streak[j]! < ZSCORE_STREAK) continue;
          const crit = metric === 'cpu' ? p.cpu > 90 : metric === 'mem' ? p.mem > 92 : metric === 'err' ? p.err > 5 : p.lat > 4 * base.lat;
          const severity = crit ? 'crit' : 'warn';
          const existing = this.firing.get(key);
          if (!existing) {
            const msg = `${metric} ${p[metric]}${METRIC_UNITS[metric]} on ${node.nodeId}, expected about ${base[metric]}${METRIC_UNITS[metric]}`;
            this.fire(tSec, node, key, metric, 'zscore', severity, p[metric], round1(base[metric] + MIN_DELTA[metric]), msg);
          } else if (severity === 'crit' && existing.severity === 'warn') {
            existing.severity = 'crit';
            existing.value = p[metric];
            this.emitAlert('upd', existing);
          }
        } else {
          this.streak[j] = 0;
          if (this.firing.has(key) && ++this.okStreak[j]! >= RESOLVE_STREAK) this.resolve(tSec, key);
        }
      }
    }

    // Node status = highest severity among its firing alerts; a missing heartbeat shows as silent.
    this.status.fill(NodeStatus.ok);
    for (const a of this.firing.values()) {
      const idx = world.nodeById.get(a.nodeId)!.idx;
      const s = a.rule === 'heartbeat' ? NodeStatus.silent : a.severity === 'crit' ? NodeStatus.crit : NodeStatus.warn;
      if (s > this.status[idx]!) this.status[idx] = s;
    }

    this.closeQuietIncidents(tSec);
    this.expireRuns(tSec);
    this.frame = this.buildFrame(tSec, points);
    for (const l of this.listeners) l.onTick(this.frame);
  }

  private buildFrame(tSec: number, points: (MetricValues | null)[]): TickFrame {
    const { world } = this;
    const topoRows: TopoTickRow[] = [];
    const svcPts: SvcPt[] = [];
    let reporting = 0;

    for (const svc of SERVICES) {
      let cpu = 0;
      let mem = 0;
      let err = 0;
      let rps = 0;
      let count = 0;
      let healthy = 0;
      let total = 0;
      let worst = 0;
      const lats: number[] = [];
      for (const node of world.nodes) {
        if (node.svcIdx !== svc.idx) continue;
        total++;
        const st = this.status[node.idx]!;
        if (st === NodeStatus.ok) healthy++;
        // A silent node degrades the service; only a crit alert makes the service crit.
        worst = Math.max(worst, st === NodeStatus.silent ? NodeStatus.warn : st);
        const p = points[node.idx];
        if (!p) continue;
        count++;
        cpu += p.cpu;
        mem += p.mem;
        err += p.err;
        rps += p.rps;
        lats.push(p.lat);
      }
      reporting += count;
      lats.sort((a, b) => a - b);
      const latP95 = lats.length ? lats[Math.max(0, Math.ceil(0.95 * lats.length) - 1)]! : 0;
      const d = count || 1;
      topoRows.push([svc.idx, round1(cpu / d), round1(latP95), round1(err / d), round1(rps), healthy, total, worst as NodeStatus]);
      svcPts.push([svc.idx, tSec * 1000, round1(cpu / d), round1(mem / d), round1(latP95), round1(err / d), round1(rps)]);
    }

    // Plausible pipeline numbers so the Pipeline page has something to draw. Not measurements. Active
    // chaos scenarios move the counters the way the plan says the real ones should (§8.9).
    const active = new Set(this.activeRuns(tSec).map((r) => r.scenario));
    const surge = active.has('traffic-surge');
    const eps = reporting * 2 * (surge ? 5 : 1);
    const shed429 = surge ? Math.round(eps * 0.08) : 0;
    const duplicate = active.has('duplicate-storm') ? eps * 2 : 0;
    const flood = active.has('malformed-flood');
    const stats: PipelineStats = {
      ts: tSec * 1000,
      eps,
      accepted: eps - shed429,
      duplicate,
      outOfOrder: duplicate ? Math.round(eps * 0.3) : 0,
      lateCorrected: duplicate ? Math.round(reporting * 0.1) : 0,
      stale: 0,
      rejected: flood ? 200 : 0,
      shed429: shed429 + (flood ? 140 : 0),
      bucketsOpen: reporting * 3,
      writeBatch: reporting,
      writeMs: surge ? 18 : 6,
      writeBuffer: surge ? reporting * 4 : 0,
      writeDropped: 0,
      socketsDash: this.listeners.size,
      rooms: 0,
      emitsPerSec: 0,
      bytesOutPerSec: 0,
      loopLagP99: surge ? 140 : flood ? 35 : 4,
      rssMb: 140,
      clientE2eP95: 0,
      shedding: surge,
    };
    return { tSec, points, status: this.status.slice(), topoRows, svcPts, stats };
  }

  // ------------------------------------------------------------------ alerts

  private fire(
    tSec: number,
    node: MockNode,
    key: string,
    metric: string,
    rule: AlertDTO['rule'],
    severity: AlertDTO['severity'],
    value: number,
    threshold: number,
    message: string,
  ): void {
    const alert: AlertDTO = {
      id: newId(),
      key,
      nodeId: node.nodeId,
      serviceId: node.serviceId,
      team: node.team,
      metric,
      rule,
      severity,
      state: 'firing',
      value,
      threshold,
      message,
      startedAt: tSec * 1000,
      ackedBy: null,
      resolvedAt: null,
      incidentId: null,
    };
    this.firing.set(key, alert);
    this.alertLog.unshift(alert);
    if (this.alertLog.length > 1000) this.alertLog.length = 1000;
    this.correlate(alert);
    this.emitAlert('new', alert);
  }

  private resolve(tSec: number, key: string): void {
    const alert = this.firing.get(key);
    if (!alert) return;
    this.firing.delete(key);
    alert.state = 'resolved';
    alert.resolvedAt = tSec * 1000;
    this.emitAlert('upd', alert);
  }

  private emitAlert(kind: 'new' | 'upd', alert: AlertDTO): void {
    for (const l of this.listeners) l.onAlert(kind, { ...alert });
  }

  ack(id: string, user: UserDTO): AlertDTO {
    if (user.role === 'viewer') throw new MockHttpError(403, 'forbidden', 'Only SREs and admins can acknowledge alerts');
    const alert = this.alertLog.find((a) => a.id === id);
    if (!alert) throw new MockHttpError(404, 'not_found', 'Alert not found');
    if (alert.state === 'firing') {
      alert.state = 'acked';
      alert.ackedBy = user.name;
      this.emitAlert('upd', alert);
    }
    return { ...alert };
  }

  // ------------------------------------------------------------------ correlator (§8.7)

  private correlate(alert: AlertDTO): void {
    const svc = alert.serviceId as ServiceId;
    const matches = this.incidents.filter((i) => {
      if (i.dto.state !== 'open' || alert.startedAt - i.lastAlertAt >= INCIDENT_JOIN_WINDOW_MS) return false;
      const affected = i.dto.affected as ServiceId[];
      return affected.includes(svc) || affected.some((a) => neighbours(a).includes(svc));
    });
    // An alert can bridge two incidents that started apart (orders-api and worker both alert before db,
    // their shared dependency, does). Fold the newer ones into the oldest so one cascade is one incident.
    let inc = matches.sort((a, b) => a.dto.startedAt - b.dto.startedAt)[0];
    for (const other of matches.slice(1)) this.mergeInto(inc!, other, alert.startedAt);
    const isNew = !inc;
    if (!inc) {
      inc = {
        dto: { id: newId(), title: '', state: 'open', epicenter: null, confidence: 0, affected: [], blastRadius: [], startedAt: alert.startedAt, endedAt: null },
        lastAlertAt: alert.startedAt,
        alertIds: new Set(),
        onset: new Map(),
        quietSince: null,
        timeline: [],
      };
      this.incidents.unshift(inc);
      if (this.incidents.length > 100) this.incidents.length = 100;
    }

    inc.alertIds.add(alert.id);
    inc.lastAlertAt = alert.startedAt;
    inc.quietSince = null;
    alert.incidentId = inc.dto.id;
    if (!inc.onset.has(svc)) inc.onset.set(svc, alert.startedAt);
    if (!inc.dto.affected.includes(svc)) inc.dto.affected.push(svc);
    inc.timeline.push({ ts: alert.startedAt, kind: 'alert', text: alert.message });

    // A = services with a firing alert in this incident. The epicenter is the deepest of them with the earliest onset.
    const active = new Set<ServiceId>();
    for (const a of this.firing.values()) if (inc.alertIds.has(a.id)) active.add(a.serviceId as ServiceId);
    const candidates = [...active].filter((s) => ![...transitiveDeps(s)].some((d) => active.has(d)));
    candidates.sort((a, b) => inc!.onset.get(a)! - inc!.onset.get(b)!);
    const epicenter = candidates[0] ?? null;
    if (epicenter) {
      const blast = transitiveDependents(epicenter);
      const explained = [...active].filter((s) => s === epicenter || blast.has(s)).length;
      if (inc.dto.epicenter !== epicenter) {
        inc.timeline.push({ ts: alert.startedAt, kind: 'epicenter', text: `Epicenter identified: ${epicenter}` });
      }
      inc.dto.epicenter = epicenter;
      inc.dto.blastRadius = [...blast];
      inc.dto.confidence = Math.round((explained / active.size) * 100) / 100;
      const n = inc.dto.affected.length;
      inc.dto.title = `${epicenter}: ${alert.metric} ${alert.rule} — ${n} service${n === 1 ? '' : 's'} affected`;
    }
    for (const l of this.listeners) l.onIncident(isNew ? 'new' : 'upd', this.cloneIncident(inc));
  }

  private mergeInto(target: IncidentRec, other: IncidentRec, ts: number): void {
    for (const id of other.alertIds) target.alertIds.add(id);
    for (const a of this.alertLog) if (a.incidentId === other.dto.id) a.incidentId = target.dto.id;
    for (const [svc, t] of other.onset) target.onset.set(svc, Math.min(t, target.onset.get(svc) ?? t));
    for (const svc of other.dto.affected) if (!target.dto.affected.includes(svc)) target.dto.affected.push(svc);
    target.timeline = [...target.timeline, ...other.timeline].sort((a, b) => a.ts - b.ts);
    target.lastAlertAt = Math.max(target.lastAlertAt, other.lastAlertAt);
    this.incidents = this.incidents.filter((i) => i !== other);
    // Tell clients that already saw the absorbed incident that it is over.
    other.dto.state = 'resolved';
    other.dto.endedAt = ts;
    for (const l of this.listeners) l.onIncident('upd', this.cloneIncident(other));
  }

  private closeQuietIncidents(tSec: number): void {
    const ts = tSec * 1000;
    for (const inc of this.incidents) {
      if (inc.dto.state !== 'open') continue;
      let anyFiring = false;
      for (const a of this.firing.values()) {
        if (inc.alertIds.has(a.id)) {
          anyFiring = true;
          break;
        }
      }
      if (anyFiring) {
        inc.quietSince = null;
      } else if (inc.quietSince === null) {
        inc.quietSince = ts;
      } else if (ts - inc.quietSince >= INCIDENT_RESOLVE_QUIET_MS) {
        inc.dto.state = 'resolved';
        inc.dto.endedAt = ts;
        inc.timeline.push({ ts, kind: 'resolve', text: 'All alerts resolved' });
        for (const l of this.listeners) l.onIncident('upd', this.cloneIncident(inc));
      }
    }
  }

  private cloneIncident(inc: IncidentRec): IncidentDTO {
    return { ...inc.dto, affected: [...inc.dto.affected], blastRadius: [...inc.dto.blastRadius] };
  }

  // ------------------------------------------------------------------ access (§7.2)

  private incidentTouches(inc: IncidentRec, teams: Team[]): boolean {
    return inc.dto.affected.some((s) => isServiceId(s) && teams.includes(SERVICE_BY_ID[s].team));
  }

  canJoin(user: UserDTO, roomName: string): boolean {
    const r = parseRoom(roomName);
    if (!r) return false;
    if (user.role !== 'viewer') return true;
    const teams = teamsOf(user);
    switch (r.kind) {
      case 'fleet':
      case 'alerts':
        return (teams as string[]).includes(r.arg);
      case 'node': {
        const node = this.world.nodeById.get(r.arg);
        return !!node && teams.includes(node.team);
      }
      case 'service':
        return isServiceId(r.arg) && teams.includes(SERVICE_BY_ID[r.arg].team);
      case 'incident': {
        const inc = this.incidents.find((i) => i.dto.id === r.arg);
        return !!inc && this.incidentTouches(inc, teams);
      }
      default:
        return true; // topology, meta
    }
  }

  // ------------------------------------------------------------------ REST (§6.2)

  topology(user: UserDTO): TopologyResponse {
    const teams = teamsOf(user);
    return {
      services: SERVICES.map((s) => ({
        idx: s.idx,
        id: s.id,
        name: s.name,
        team: s.team,
        sloMs: s.sloMs,
        layer: s.layer,
        dependsOn: s.dependsOn.map((d) => d.service),
      })),
      edges: EDGES.map((e) => ({ ...e })),
      teams: [...TEAMS],
      regions: REGIONS.map((r) => r.id),
      nodes: this.world.nodes.filter((n) => teams.includes(n.team)).map((n) => [n.idx, n.nodeId, n.serviceId, n.region, n.az]),
    };
  }

  /** Builds a columnar series from a per-second sampler. Only finalized seconds (≤ cursor) are returned. */
  private series(from: number, to: number, res: string, sample: (tSec: number) => MetricValues | null): ColumnarSeries {
    if (!(to > from)) throw new MockHttpError(400, 'bad_request', '`to` must be greater than `from`');
    const use1s = res === '1s' || (res !== '1m' && to - from <= AUTO_1S_MAX_RANGE_MS);
    const step = use1s ? 1 : 60;
    const out: ColumnarSeries = { res: use1s ? '1s' : '1m', t: [], rev: [], cpu: [], mem: [], disk: [], netIn: [], netOut: [], lat: [], err: [], rps: [] };

    const last = Math.min(Math.floor(to / 1000), this.cursor);
    let start = Math.ceil(from / 1000 / step) * step;
    // Hard cap: keep the newest points.
    start = Math.max(start, Math.floor(last / step) * step - (HISTORY_MAX_POINTS - 1) * step);

    for (let t = start; t <= last; t += step) {
      const acc: MetricValues = { cpu: 0, mem: 0, disk: 0, netIn: 0, netOut: 0, lat: 0, err: 0, rps: 0 };
      let count = 0;
      for (let s = t; s < t + step && s <= last; s++) {
        const p = sample(s);
        if (!p) continue;
        count++;
        for (const m of METRICS) acc[m] += p[m];
      }
      if (!count) continue; // the node was silent: a real gap, not a zero
      out.t.push(t * 1000);
      out.rev.push(0);
      for (const m of METRICS) out[m].push(round1(acc[m] / count));
    }
    return out;
  }

  nodeSeries(user: UserDTO, nodeId: string, from: number, to: number, res = 'auto'): NodeSeriesResponse {
    const node = this.world.nodeById.get(nodeId);
    if (!node) throw new MockHttpError(404, 'not_found', `Unknown node ${nodeId}`);
    if (!teamsOf(user).includes(node.team)) throw new MockHttpError(403, 'forbidden', 'That node belongs to another team');
    return { nodeId, ...this.series(from, to, res, (s) => this.world.pointAt(node.idx, s)) };
  }

  serviceSeries(user: UserDTO, serviceId: string, from: number, to: number, res = 'auto'): ServiceSeriesResponse {
    if (!isServiceId(serviceId)) throw new MockHttpError(404, 'not_found', `Unknown service ${serviceId}`);
    if (!teamsOf(user).includes(SERVICE_BY_ID[serviceId].team)) throw new MockHttpError(403, 'forbidden', 'That service belongs to another team');
    const members = this.world.nodes.filter((n) => n.serviceId === serviceId);
    // Avg cpu/mem, sum rps, p95 latency across the nodes: the same aggregate svc:pt carries live, so a
    // service chart does not jump where history meets the stream. (§6.2 says max latency; see the note
    // to Person A about aligning the two.) The remaining metrics are averaged.
    const sample = (s: number): MetricValues | null => {
      const acc: MetricValues = { cpu: 0, mem: 0, disk: 0, netIn: 0, netOut: 0, lat: 0, err: 0, rps: 0 };
      let count = 0;
      let rps = 0;
      const lats: number[] = [];
      for (const n of members) {
        const p = this.world.pointAt(n.idx, s);
        if (!p) continue;
        count++;
        for (const m of METRICS) acc[m] += p[m];
        rps += p.rps;
        lats.push(p.lat);
      }
      if (!count) return null;
      for (const m of METRICS) acc[m] /= count;
      acc.rps = rps;
      lats.sort((a, b) => a - b);
      acc.lat = lats[Math.max(0, Math.ceil(0.95 * lats.length) - 1)]!;
      return acc;
    };
    return { serviceId, ...this.series(from, to, res, sample) };
  }

  /** Newest first. `before` is a cursor on startedAt. */
  alerts(user: UserDTO, q: { state?: string; limit?: number; before?: number }): AlertDTO[] {
    const teams = teamsOf(user) as string[];
    const limit = q.limit ?? ALERTS_PAGE_DEFAULT;
    const out: AlertDTO[] = [];
    for (const a of this.alertLog) {
      if (out.length >= limit) break;
      if (!teams.includes(a.team)) continue;
      if (q.state && a.state !== q.state) continue;
      if (q.before !== undefined && a.startedAt >= q.before) continue;
      out.push({ ...a });
    }
    return out;
  }

  incidentList(user: UserDTO): IncidentDTO[] {
    const teams = teamsOf(user);
    return this.incidents.filter((i) => this.incidentTouches(i, teams)).map((i) => this.cloneIncident(i));
  }

  incidentDetail(user: UserDTO, id: string): IncidentDetailDTO {
    const inc = this.incidents.find((i) => i.dto.id === id);
    if (!inc || !this.incidentTouches(inc, teamsOf(user))) throw new MockHttpError(404, 'not_found', 'Incident not found');
    return {
      ...this.cloneIncident(inc),
      alerts: this.alertLog.filter((a) => inc.alertIds.has(a.id)).map((a) => ({ ...a })),
      timeline: inc.timeline.map((e) => ({ ...e })),
      chaos: this.scorecard(inc),
    };
  }

  /**
   * The mock's scheduled faults stand in for chaos runs (task B8 adds real ones): a fault that started
   * within the link window before the incident is scored like a chaos run (§8.7).
   */
  private scorecard(inc: IncidentRec): ChaosScorecard | null {
    // A Chaos Lab run that started within the link window before the incident (§8.7).
    const run = this.runs.find((r) => r.startedAt <= inc.dto.startedAt && inc.dto.startedAt - r.startedAt <= CHAOS_LINK_WINDOW_MS);
    if (run) return this.score(run, inc);
    // Otherwise the scheduled background fault that caused it, scored the same way.
    const startSec = Math.floor(inc.dto.startedAt / 1000);
    for (let back = 0; back * 1000 <= CHAOS_LINK_WINDOW_MS; back += 5) {
      const f = this.world.scheduledAt(startSec - back);
      if (!f) continue;
      const startedAt = f.startSec * 1000;
      if (inc.dto.startedAt - startedAt > CHAOS_LINK_WINDOW_MS || startedAt > inc.dto.startedAt) return null;
      const target = f.nodeIdx !== null ? this.world.nodes[f.nodeIdx]!.nodeId : f.service;
      return {
        runId: `mock-${f.cycle}`,
        scenario: f.kind,
        target,
        startedAt,
        detectedAt: inc.dto.startedAt,
        timeToDetectMs: inc.dto.startedAt - startedAt,
        detectedEpicenter: inc.dto.epicenter,
        correct: inc.dto.epicenter === null ? null : inc.dto.epicenter === f.service,
      };
    }
    return null;
  }

  private score(run: ChaosRunRec, inc: IncidentRec | undefined): ChaosScorecard {
    return {
      runId: run.runId,
      scenario: run.scenario,
      target: run.target,
      startedAt: run.startedAt,
      detectedAt: inc?.dto.startedAt ?? null,
      timeToDetectMs: inc ? inc.dto.startedAt - run.startedAt : null,
      detectedEpicenter: inc?.dto.epicenter ?? null,
      // Fleet-wide scenarios have no single root cause to name, so they are not scored.
      correct: !inc || !run.expected || inc.dto.epicenter === null ? null : inc.dto.epicenter === run.expected,
    };
  }

  // ------------------------------------------------------------------ chaos (§6.3)

  private runs: ChaosRunRec[] = []; // newest first

  private activeRuns(tSec = this.cursor): ChaosRunRec[] {
    return this.runs.filter((r) => r.endedAt === null && r.startedAt <= tSec * 1000);
  }

  chaosActive(): ChaosUpd {
    return {
      active: this.runs
        .filter((r) => r.endedAt === null)
        .map((r): ChaosActiveRun => ({ runId: r.runId, scenario: r.scenario, target: r.target, endsAt: r.endsAt })),
    };
  }

  private emitChaos(): void {
    const upd = this.chaosActive();
    for (const l of this.listeners) l.onChaos?.({ active: upd.active.map((a) => ({ ...a })) });
  }

  private expireRuns(tSec: number): void {
    let changed = false;
    for (const r of this.runs) {
      if (r.endedAt === null && tSec * 1000 >= r.endsAt) {
        r.endedAt = r.endsAt;
        changed = true;
      }
    }
    if (changed) this.emitChaos();
  }

  chaosScenarios(user: UserDTO): { scenarios: readonly ChaosScenarioDef[]; active: ChaosActiveRun[] } {
    if (user.role !== 'admin') throw new MockHttpError(403, 'forbidden', 'Requires role: admin');
    return { scenarios: CHAOS_SCENARIOS, active: this.chaosActive().active };
  }

  /** POST /chaos/start. The fault starts at the next second the mock computes, so history never changes. */
  chaosStart(user: UserDTO, body: Partial<ChaosStartBody>): ChaosActiveRun {
    if (user.role !== 'admin') throw new MockHttpError(403, 'forbidden', 'Requires role: admin');
    const def = CHAOS_SCENARIOS.find((s) => s.id === body?.scenario);
    if (!def) throw new MockHttpError(400, 'validation_failed', 'Unknown scenario');
    const duration = body.durationSec ?? def.defaultDurationSec;
    if (!Number.isInteger(duration) || duration < 5 || duration > 1800) {
      throw new MockHttpError(400, 'validation_failed', 'Duration must be a whole number of seconds from 5 to 1800');
    }
    if (this.chaosActive().active.length >= MAX_ACTIVE_RUNS) {
      throw new MockHttpError(409, 'too_many_runs', `At most ${MAX_ACTIVE_RUNS} scenarios can run at once`);
    }

    let target: string | null = null;
    let expected: ServiceId | null = null;
    let nodeIdx: number | null = null;
    if (def.targetKind === 'node') {
      const node = body.target ? this.world.nodeById.get(body.target) : undefined;
      if (!node) throw new MockHttpError(400, 'validation_failed', 'Pick a node to target');
      target = node.nodeId;
      expected = node.serviceId;
      nodeIdx = node.idx;
    } else if (def.targetKind === 'service') {
      const svc = body.target ?? def.defaultTarget;
      if (!svc || !isServiceId(svc)) throw new MockHttpError(400, 'validation_failed', 'Pick a service to target');
      target = svc;
      expected = svc;
    }

    const startSec = this.cursor + 1;
    const run: ChaosRunRec = {
      runId: newId(),
      scenario: def.id,
      target,
      expected,
      startedAt: startSec * 1000,
      endsAt: (startSec + duration) * 1000,
      endedAt: null,
      startedBy: user.name,
    };
    this.runs.unshift(run);
    if (this.runs.length > 200) this.runs.length = 200;
    this.world.inject({ runId: run.runId, kind: def.id, startSec, endSec: startSec + duration, service: expected, nodeIdx });
    this.emitChaos();
    return { runId: run.runId, scenario: run.scenario, target: run.target, endsAt: run.endsAt };
  }

  /** POST /chaos/stop. With a runId, stops that run; without, stops every active run. */
  chaosStop(user: UserDTO, runId?: string): ChaosUpd {
    if (user.role !== 'admin') throw new MockHttpError(403, 'forbidden', 'Requires role: admin');
    const endSec = this.cursor + 1;
    for (const r of this.runs) {
      if (r.endedAt !== null || (runId && r.runId !== runId)) continue;
      r.endedAt = Math.max(r.startedAt, endSec * 1000);
      this.world.endInjected(r.runId, endSec);
    }
    this.emitChaos();
    return this.chaosActive();
  }

  /** Recent runs with their scorecards, newest first. An incident links to a run that started ≤ 120 s before it. */
  chaosRuns(user: UserDTO): (ChaosScorecard & { endsAt: number; endedAt: number | null; startedBy: string; incidentId: string | null })[] {
    if (user.role !== 'admin') throw new MockHttpError(403, 'forbidden', 'Requires role: admin');
    return this.runs.map((run) => {
      const inc = [...this.incidents]
        .reverse()
        .find((i) => i.dto.startedAt >= run.startedAt && i.dto.startedAt - run.startedAt <= CHAOS_LINK_WINDOW_MS);
      return { ...this.score(run, inc), endsAt: run.endsAt, endedAt: run.endedAt, startedBy: run.startedBy, incidentId: inc?.dto.id ?? null };
    });
  }

  /** GET /replay: 1-second columnar series for every visible node of `services`, capped at 10 minutes. */
  replay(user: UserDTO, from: number, to: number, services: string[]): ReplayResponse {
    if (!(to > from)) throw new MockHttpError(400, 'bad_request', '`to` must be greater than `from`');
    if (to - from > REPLAY_MAX_RANGE_MS) throw new MockHttpError(400, 'range_too_long', 'Replay windows are limited to 10 minutes');
    const teams = teamsOf(user);
    const wanted = new Set(services.length ? services : SERVICES.map((s) => s.id));
    const nodes = this.world.nodes
      .filter((n) => wanted.has(n.serviceId) && teams.includes(n.team))
      .map((n) => ({ nodeId: n.nodeId, ...this.series(from, to, '1s', (s) => this.world.pointAt(n.idx, s)) }));
    return { from, to, nodes };
  }

  /** POST /incidents/:id/notes. The note reaches clients through incident:note, the sender included. */
  addNote(user: UserDTO, id: string, text: string): TimelineEntry {
    if (user.role === 'viewer') throw new MockHttpError(403, 'forbidden', 'Only SREs and admins can add notes');
    const inc = this.incidents.find((i) => i.dto.id === id);
    if (!inc) throw new MockHttpError(404, 'not_found', 'Incident not found');
    const clean = String(text ?? '').trim().slice(0, 2000);
    if (!clean) throw new MockHttpError(400, 'validation_failed', 'A note needs some text');
    const entry: TimelineEntry = { ts: this.now(), kind: 'note', text: clean, user: { id: user.id, name: user.name } };
    inc.timeline.push(entry);
    for (const l of this.listeners) l.onNote?.(id, { ...entry });
    return { ...entry };
  }

  // ------------------------------------------------------------------ presence (incident war room)

  private readonly presence = new Map<string, Map<object, PresenceUser>>();

  presenceJoin(incidentId: string, who: object, user: PresenceUser): PresenceUser[] {
    let m = this.presence.get(incidentId);
    if (!m) this.presence.set(incidentId, (m = new Map()));
    m.set(who, user);
    return this.emitPresence(incidentId);
  }

  presenceLeave(incidentId: string, who: object): void {
    if (this.presence.get(incidentId)?.delete(who)) this.emitPresence(incidentId);
  }

  private emitPresence(incidentId: string): PresenceUser[] {
    // One entry per person, however many tabs they have open.
    const users = [...new Map([...(this.presence.get(incidentId)?.values() ?? [])].map((u) => [u.id, u])).values()];
    for (const l of this.listeners) l.onPresence?.(incidentId, users.map((u) => ({ ...u })));
    return users;
  }
}

// ---------------------------------------------------------------------- singleton

let backend: MockBackend | null = null;

/**
 * `?mockNodes=500` in the URL scales the fleet. Read when the page loads (the login redirect drops the
 * query string) and remembered for the tab.
 */
const requestedNodes: number | undefined = (() => {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('mockNodes');
    if (fromUrl) sessionStorage.setItem('epicenter.mockNodes', fromUrl);
    const n = Number(fromUrl ?? sessionStorage.getItem('epicenter.mockNodes'));
    return Number.isFinite(n) && n >= 9 && n <= 5000 ? Math.round(n) : undefined;
  } catch {
    return undefined; // no window (tests) or storage blocked
  }
})();

export function getMockBackend(): MockBackend {
  if (!backend) {
    backend = new MockBackend({ nodes: requestedNodes });
    backend.start();
  }
  return backend;
}

