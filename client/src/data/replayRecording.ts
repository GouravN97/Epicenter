// An incident recording for replay (plan §9.2 replayPlayer). Built once from GET /replay plus the incident's
// alerts; `frameAt(t)` reconstructs what the fleet looked like at any second of the window, and
// `snapshotAt(t)` what the topology looked like, so the heatmap and the map can render the recorded state.
// It never touches the live store, so "Go Live" is just a switch back: nothing to undo, nothing missed.
import { METRICS, NodeStatus, SERVICES, type AlertDTO, type ReplayResponse } from '@epicenter/shared';
import type { FleetState } from './fleetState';
import type { ServiceSnapshot, TopoSnapshot } from './useTopoSnapshot';

export type ReplayMetric = 'cpu' | 'mem' | 'lat' | 'err' | 'rps';

interface RecNode {
  idx: number;
  nodeId: string;
  svcIdx: number;
  t: Float64Array;
  cols: Record<ReplayMetric, Float32Array>;
  alerts: AlertDTO[];
}

const svcIdxOf = new Map<string, number>(SERVICES.map((s) => [s.id as string, s.idx]));
const SEVERITY = (a: AlertDTO): NodeStatus => (a.rule === 'heartbeat' ? NodeStatus.silent : a.severity === 'crit' ? NodeStatus.crit : NodeStatus.warn);

export class ReplayRecording {
  readonly from: number;
  readonly to: number;
  readonly nodes: RecNode[];
  /** svcIdx of every service with at least one recorded node. */
  readonly services: Set<number>;

  constructor(res: ReplayResponse, alerts: AlertDTO[], idxOf: (nodeId: string) => number | undefined) {
    this.from = res.from;
    this.to = res.to;
    const byNode = new Map<string, AlertDTO[]>();
    for (const a of alerts) byNode.set(a.nodeId, [...(byNode.get(a.nodeId) ?? []), a]);
    this.nodes = [];
    for (const s of res.nodes) {
      const idx = idxOf(s.nodeId);
      const svcIdx = svcIdxOf.get(s.nodeId.split('.')[1] ?? '');
      if (idx === undefined || svcIdx === undefined) continue; // not in this user's topology
      const pick = (m: ReplayMetric) => Float32Array.from(s[m]);
      this.nodes.push({
        idx,
        nodeId: s.nodeId,
        svcIdx,
        t: Float64Array.from(s.t),
        cols: { cpu: pick('cpu'), mem: pick('mem'), lat: pick('lat'), err: pick('err'), rps: pick('rps') },
        alerts: byNode.get(s.nodeId) ?? [],
      });
    }
    this.services = new Set(this.nodes.map((n) => n.svcIdx));
  }

  /** Index of the node's point for the second containing `t`, or −1 when it did not report then. */
  private pointIndex(n: RecNode, t: number): number {
    const bucket = Math.floor(t / 1000) * 1000;
    let lo = 0;
    let hi = n.t.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (n.t[mid]! <= bucket) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // A point a second old still counts (the newest second may not be finalized yet); older means silent.
    return found >= 0 && bucket - n.t[found]! <= 1000 ? found : -1;
  }

  private statusOf(n: RecNode, t: number, reporting: boolean): NodeStatus {
    let s: NodeStatus = reporting ? NodeStatus.ok : NodeStatus.silent;
    for (const a of n.alerts) {
      if (a.startedAt > t || (a.resolvedAt != null && t >= a.resolvedAt)) continue;
      const sev = SEVERITY(a);
      if (sev > s) s = sev;
    }
    return s;
  }

  /** Writes the recorded nodes' state at `t` into `fleet` (other nodes are cleared to "no data"). */
  frameAt(t: number, fleet: FleetState, size: number): void {
    fleet.resize(size);
    fleet.seen.fill(0);
    for (const n of this.nodes) {
      const i = this.pointIndex(n, t);
      fleet.seen[n.idx] = 1;
      fleet.status[n.idx] = this.statusOf(n, t, i >= 0);
      fleet.cpu[n.idx] = i >= 0 ? Math.round(n.cols.cpu[i]!) : 0;
      fleet.mem[n.idx] = i >= 0 ? Math.round(n.cols.mem[i]!) : 0;
    }
    fleet.tsSec = Math.floor(t / 1000);
    fleet.version++;
  }

  /** Per-service aggregates at `t`, in the shape the topology map takes (avg cpu/err, p95 lat, sum rps). */
  snapshotAt(t: number): TopoSnapshot {
    const services: ServiceSnapshot[] = SERVICES.map(() => ({ cpu: 0, lat: 0, err: 0, rps: 0, healthy: 0, total: 0, status: 0 }));
    const lats: number[][] = SERVICES.map(() => []);
    const counts = SERVICES.map(() => 0);
    for (const n of this.nodes) {
      const s = services[n.svcIdx]!;
      const i = this.pointIndex(n, t);
      const st = this.statusOf(n, t, i >= 0);
      s.total++;
      if (st === NodeStatus.ok) s.healthy++;
      s.status = Math.max(s.status, st === NodeStatus.silent ? NodeStatus.warn : st);
      if (i < 0) continue;
      counts[n.svcIdx]!++;
      s.cpu += n.cols.cpu[i]!;
      s.err += n.cols.err[i]!;
      s.rps += n.cols.rps[i]!;
      lats[n.svcIdx]!.push(n.cols.lat[i]!);
    }
    services.forEach((s, k) => {
      const c = counts[k]!;
      if (c) {
        s.cpu /= c;
        s.err /= c;
      }
      const l = lats[k]!.sort((a, b) => a - b);
      s.lat = l.length ? l[Math.max(0, Math.ceil(0.95 * l.length) - 1)]! : 0;
    });
    return { tsSec: Math.floor(t / 1000), services };
  }

  /**
   * One value per second across the window for a service: p95 for latency, the sum for traffic, the mean
   * otherwise; null where no node reported.
   */
  serviceSeries(svcIdx: number, metric: ReplayMetric): { t: number[]; v: (number | null)[] } {
    const members = this.nodes.filter((n) => n.svcIdx === svcIdx);
    const t: number[] = [];
    const v: (number | null)[] = [];
    for (let ts = Math.ceil(this.from / 1000) * 1000; ts <= this.to; ts += 1000) {
      const vals: number[] = [];
      for (const n of members) {
        const i = this.pointIndex(n, ts);
        if (i >= 0 && n.t[i] === ts) vals.push(n.cols[metric][i]!);
      }
      t.push(ts);
      if (!vals.length) v.push(null);
      else if (metric === 'lat') v.push(vals.sort((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * vals.length) - 1)]!);
      else if (metric === 'rps') v.push(vals.reduce((a, b) => a + b, 0));
      else v.push(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    return { t, v };
  }
}

/** Which metric best shows an incident: the one its first alert fired on. */
export function incidentMetric(alerts: AlertDTO[]): ReplayMetric {
  const first = [...alerts].sort((a, b) => a.startedAt - b.startedAt).find((a) => (METRICS as readonly string[]).includes(a.metric));
  const m = first?.metric;
  return m === 'cpu' || m === 'mem' || m === 'err' || m === 'rps' ? m : 'lat';
}

/**
 * The replay window for an incident: from a minute before it started to 30 s after it ended (or now),
 * capped at the server's 10-minute limit from the start.
 */
export function replayWindow(inc: { startedAt: number; endedAt: number | null }, now: number, maxMs: number): { from: number; to: number } {
  const from = Math.floor((inc.startedAt - 60_000) / 1000) * 1000;
  const end = inc.endedAt !== null ? Math.min(inc.endedAt + 30_000, now) : now;
  return { from, to: Math.max(from + 1000, Math.min(end, from + maxMs)) };
}
