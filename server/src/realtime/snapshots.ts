// Pure builders for broadcast payloads (plan §7.3, §8.5).
import {
  FLEET_DELTA_MIN_CHANGE,
  NodeStatus,
  round1,
  type FleetDeltaRow,
  type MetricValues,
  type TopoTickRow,
} from '@epicenter/shared';

/**
 * Tracks what a fleet:<team> room was last sent. diff() returns only rows whose cpu or mem moved by at least
 * FLEET_DELTA_MIN_CHANGE or whose status changed, and records them as sent. snapshot() is what a client that
 * joins now must start from, so its view matches everyone else's and later deltas apply cleanly.
 */
export class FleetDiffer {
  private readonly last = new Map<number, FleetDeltaRow>();

  diff(rows: FleetDeltaRow[]): FleetDeltaRow[] {
    const out: FleetDeltaRow[] = [];
    for (const row of rows) {
      const prev = this.last.get(row[0]);
      if (
        !prev ||
        prev[3] !== row[3] ||
        Math.abs(prev[1] - row[1]) >= FLEET_DELTA_MIN_CHANGE ||
        Math.abs(prev[2] - row[2]) >= FLEET_DELTA_MIN_CHANGE
      ) {
        this.last.set(row[0], row);
        out.push(row);
      }
    }
    return out;
  }

  snapshot(): FleetDeltaRow[] {
    return [...this.last.values()].sort((a, b) => a[0] - b[0]);
  }
}

/** One fleet row from the newest raw metrics. Nodes with no data yet report 0/0 and their status. */
export const fleetRow = (idx: number, last: MetricValues | null, status: NodeStatus): FleetDeltaRow => [
  idx,
  last ? Math.round(last.cpu) : 0,
  last ? Math.round(last.mem) : 0,
  status,
];

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

export interface ServiceAgg {
  ts: number;
  cpuAvg: number;
  memAvg: number;
  latP95: number;
  errAvg: number;
  rps: number;
}

/** Aggregates one second's finalized points for one service. */
export function aggregateService(ts: number, points: MetricValues[]): ServiceAgg {
  const n = points.length || 1;
  const sum = (k: keyof MetricValues) => points.reduce((a, p) => a + p[k], 0);
  return {
    ts,
    cpuAvg: round1(sum('cpu') / n),
    memAvg: round1(sum('mem') / n),
    latP95: round1(percentile(points.map((p) => p.lat), 0.95)),
    errAvg: round1(sum('err') / n),
    rps: round1(sum('rps')),
  };
}

/**
 * Service status from its nodes: the worst alert status among live nodes; a silent node makes the service
 * at least warn; a service whose nodes are all silent is silent.
 */
export function serviceStatus(statuses: NodeStatus[]): NodeStatus {
  if (statuses.length === 0) return NodeStatus.silent;
  let worst: NodeStatus = NodeStatus.ok;
  let silent = 0;
  for (const s of statuses) {
    if (s === NodeStatus.silent) silent++;
    else if (s > worst) worst = s;
  }
  if (silent === statuses.length) return NodeStatus.silent;
  return silent > 0 && worst < NodeStatus.warn ? NodeStatus.warn : worst;
}

export function topoRow(svcIdx: number, agg: ServiceAgg | undefined, statuses: NodeStatus[]): TopoTickRow {
  const healthy = statuses.filter((s) => s === NodeStatus.ok).length;
  return [
    svcIdx,
    agg?.cpuAvg ?? 0,
    agg?.latP95 ?? 0,
    agg?.errAvg ?? 0,
    agg?.rps ?? 0,
    healthy,
    statuses.length,
    serviceStatus(statuses),
  ];
}
