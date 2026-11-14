// Anomaly detection (plan §8.6). Pure in-memory logic: no database, no sockets. Runs on each finalized
// (non-correction) 1 s point, plus a 1 s heartbeat sweep. Emits alert lifecycle events to listeners, which
// persist (alertStore) and broadcast them, and later feed the correlator (A9).
//
// One active alert per key `nodeId|metric|rule`. "Active" = firing or acked. An alert resolves after its rule
// condition has been false for RESOLVE_STREAK consecutive points.
import {
  DETECTED_METRICS,
  EWMA_ALPHA,
  HEARTBEAT_TIMEOUT_MS,
  MIN_DELTA,
  NodeStatus,
  RESOLVE_STREAK,
  SERVICE_BY_ID,
  TREND_HORIZON_S,
  TREND_MEM_LIMIT,
  TREND_MIN_R2,
  TREND_WINDOW,
  ZSCORE_CRIT,
  ZSCORE_STREAK,
  ZSCORE_THRESHOLD,
  ZSCORE_WARMUP,
  type AlertDTO,
  type AlertRule,
  type DetectedMetric,
  type MetricValues,
  type ServiceId,
  type Severity,
  type Team,
} from '@epicenter/shared';

export interface DetectorPoint extends MetricValues {
  nodeId: string;
  ts: number;
}

export interface NodeMeta {
  serviceId: ServiceId;
  team: Team;
}

/** Threshold rules: metric > limit for `points` consecutive points. lat's limit is 3 × the service SLO. */
export const THRESHOLDS: { metric: 'cpu' | 'mem' | 'err' | 'lat'; limit: (svc: ServiceId) => number; points: number; severity: Severity; unit: string }[] = [
  { metric: 'cpu', limit: () => 90, points: 10, severity: 'crit', unit: '%' },
  { metric: 'mem', limit: () => 92, points: 10, severity: 'crit', unit: '%' },
  { metric: 'err', limit: () => 5, points: 5, severity: 'crit', unit: '%' },
  { metric: 'lat', limit: (svc) => 3 * SERVICE_BY_ID[svc].sloMs, points: 5, severity: 'warn', unit: 'ms' },
];

const UNITS: Record<string, string> = { cpu: '%', mem: '%', err: '%', lat: 'ms', netIn: 'kB/s' };
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));

/** Least-squares fit of y over x = 0..n-1. */
export function linearFit(ys: readonly number[]): { slope: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const mx = (n - 1) / 2;
  let my = 0;
  for (const y of ys) my += y;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

interface ZState {
  mean: number;
  variance: number;
  warm: number;
  streak: number;
}

interface NodeDetState {
  z: Partial<Record<DetectedMetric, ZState>>;
  /** Consecutive points over each threshold. */
  over: Record<string, number>;
  mem: number[];
}

/** An active alert plus the detector's bookkeeping. */
interface Active {
  alert: AlertDTO;
  /** Consecutive points with the rule condition false. */
  okStreak: number;
}

export interface DetectorListeners {
  fire?: (a: AlertDTO) => void;
  /** Severity, value or ack changed on an active alert. */
  update?: (a: AlertDTO) => void;
  resolve?: (a: AlertDTO) => void;
}

const SEV_STATUS: Record<Severity, NodeStatus> = { warn: NodeStatus.warn, crit: NodeStatus.crit };

export class Detector {
  private readonly nodes = new Map<string, NodeDetState>();
  private readonly active = new Map<string, Active>();
  private readonly listeners: DetectorListeners[] = [];

  constructor(
    private readonly meta: (nodeId: string) => NodeMeta | undefined,
    private readonly newId: () => string,
  ) {}

  on(l: DetectorListeners): void {
    this.listeners.push(l);
  }

  /** Highest severity among a node's active alerts (ok if none). */
  nodeStatus(nodeId: string): NodeStatus {
    let s: NodeStatus = NodeStatus.ok;
    for (const a of this.active.values()) {
      if (a.alert.nodeId === nodeId) s = Math.max(s, SEV_STATUS[a.alert.severity]) as NodeStatus;
    }
    return s;
  }

  activeAlerts(): AlertDTO[] {
    return [...this.active.values()].map((a) => a.alert);
  }

  getActive(id: string): AlertDTO | undefined {
    for (const a of this.active.values()) if (a.alert.id === id) return a.alert;
    return undefined;
  }

  /** Marks an active alert acked. Returns it, or undefined if it is not active here. */
  ack(id: string, userId: string): AlertDTO | undefined {
    const a = this.getActive(id);
    if (!a) return undefined;
    if (a.state === 'firing') {
      a.state = 'acked';
      a.ackedBy = userId;
      this.emit('update', a);
    }
    return a;
  }

  // ---------------------------------------------------------------- per point

  onPoint(p: DetectorPoint): void {
    const meta = this.meta(p.nodeId);
    if (!meta) return;
    let st = this.nodes.get(p.nodeId);
    if (!st) {
      st = { z: {}, over: {}, mem: [] };
      this.nodes.set(p.nodeId, st);
    }
    for (const m of DETECTED_METRICS) this.zscore(p, meta, st, m);
    for (const t of THRESHOLDS) this.threshold(p, meta, st, t);
    this.trend(p, meta, st);
    // Data is flowing again: count towards resolving a heartbeat alert.
    this.step(`${p.nodeId}|heartbeat|heartbeat`, false, p.ts, 0);
  }

  private zscore(p: DetectorPoint, meta: NodeMeta, st: NodeDetState, m: DetectedMetric): void {
    const x = p[m];
    let z = st.z[m];
    if (!z) {
      st.z[m] = { mean: x, variance: 0, warm: 1, streak: 0 };
      return;
    }
    let hit = false;
    let score = 0;
    if (z.warm >= ZSCORE_WARMUP) {
      score = (x - z.mean) / Math.sqrt(z.variance + 1e-6);
      hit = Math.abs(score) > ZSCORE_THRESHOLD && Math.abs(x - z.mean) > MIN_DELTA[m];
    }
    z.streak = hit ? z.streak + 1 : 0;
    const key = `${p.nodeId}|${m}|zscore`;
    const severity: Severity = Math.abs(score) > ZSCORE_CRIT ? 'crit' : 'warn';
    const msg = () =>
      `${m} ${fmt(x)}${UNITS[m]} is ${fmt(Math.abs(score))}σ ${score > 0 ? 'above' : 'below'} baseline ${fmt(z!.mean)}${UNITS[m]}`;
    if (z.streak >= ZSCORE_STREAK) this.fireOrUpdate(key, p, meta, m, 'zscore', severity, x, z.mean, msg);
    else this.step(key, hit, p.ts, x);
    if (!hit) {
      // Baseline is frozen while anomalous, so a sustained fault does not become the new normal.
      const d = x - z.mean;
      z.mean += EWMA_ALPHA * d;
      z.variance = (1 - EWMA_ALPHA) * (z.variance + EWMA_ALPHA * d * d);
      z.warm++;
    }
  }

  private threshold(p: DetectorPoint, meta: NodeMeta, st: NodeDetState, t: (typeof THRESHOLDS)[number]): void {
    const x = p[t.metric];
    const limit = t.limit(meta.serviceId);
    const over = x > limit;
    st.over[t.metric] = over ? (st.over[t.metric] ?? 0) + 1 : 0;
    const key = `${p.nodeId}|${t.metric}|threshold`;
    if (st.over[t.metric]! >= t.points) {
      this.fireOrUpdate(key, p, meta, t.metric, 'threshold', t.severity, x, limit, () =>
        `${t.metric} ${fmt(x)}${t.unit} over ${fmt(limit)}${t.unit} for ${st.over[t.metric]} s`,
      );
    } else this.step(key, over, p.ts, x);
  }

  private trend(p: DetectorPoint, meta: NodeMeta, st: NodeDetState): void {
    st.mem.push(p.mem);
    if (st.mem.length > TREND_WINDOW) st.mem.shift();
    const key = `${p.nodeId}|mem|predictive`;
    if (st.mem.length < TREND_WINDOW) return;
    const { slope, r2 } = linearFit(st.mem);
    const eta = slope > 0 ? (TREND_MEM_LIMIT - p.mem) / slope : Infinity;
    const hit = slope > 0 && r2 > TREND_MIN_R2 && eta < TREND_HORIZON_S && eta > 0;
    if (hit) {
      this.fireOrUpdate(key, p, meta, 'mem', 'predictive', 'warn', p.mem, TREND_MEM_LIMIT, () => {
        const s = Math.max(0, Math.round(eta));
        return `memory exhausts in ~${Math.floor(s / 60)}m ${s % 60}s (${fmt(p.mem)}%, +${slope.toFixed(2)}%/s)`;
      });
    } else this.step(key, false, p.ts, p.mem);
  }

  // ---------------------------------------------------------------- heartbeat

  /** Fires a crit heartbeat alert for every node silent for longer than HEARTBEAT_TIMEOUT_MS. */
  checkHeartbeats(now: number, nodes: Iterable<{ nodeId: string; lastSeen: number }>): void {
    for (const n of nodes) {
      if (n.lastSeen <= 0) continue; // never reported: nothing to miss
      const silentMs = now - n.lastSeen;
      if (silentMs <= HEARTBEAT_TIMEOUT_MS) continue;
      const meta = this.meta(n.nodeId);
      if (!meta) continue;
      const key = `${n.nodeId}|heartbeat|heartbeat`;
      const a = this.active.get(key);
      if (a) {
        a.okStreak = 0; // still silent
        continue;
      }
      this.fire(key, { nodeId: n.nodeId, ts: now }, meta, 'heartbeat', 'heartbeat', 'crit', silentMs / 1000, HEARTBEAT_TIMEOUT_MS / 1000,
        `no data for ${Math.round(silentMs / 1000)} s`);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private fireOrUpdate(
    key: string,
    p: { nodeId: string; ts: number },
    meta: NodeMeta,
    metric: string,
    rule: AlertRule,
    severity: Severity,
    value: number,
    threshold: number,
    message: () => string,
  ): void {
    const a = this.active.get(key);
    if (!a) return this.fire(key, p, meta, metric, rule, severity, value, threshold, message());
    a.okStreak = 0;
    a.alert.value = value;
    // Escalate (never de-escalate) while active.
    if (severity === 'crit' && a.alert.severity === 'warn') {
      a.alert.severity = 'crit';
      a.alert.message = message();
      this.emit('update', a.alert);
    }
  }

  private fire(
    key: string,
    p: { nodeId: string; ts: number },
    meta: NodeMeta,
    metric: string,
    rule: AlertRule,
    severity: Severity,
    value: number,
    threshold: number,
    message: string,
  ): void {
    const alert: AlertDTO = {
      id: this.newId(),
      key,
      nodeId: p.nodeId,
      serviceId: meta.serviceId,
      team: meta.team,
      metric,
      rule,
      severity,
      state: 'firing',
      value: Math.round(value * 100) / 100,
      threshold: Math.round(threshold * 100) / 100,
      message,
      startedAt: p.ts,
      ackedBy: null,
      resolvedAt: null,
      incidentId: null,
    };
    this.active.set(key, { alert, okStreak: 0 });
    this.emit('fire', alert);
  }

  /** Records one point where the rule's condition was `hit` (or not) for an alert that may be active. */
  private step(key: string, hit: boolean, ts: number, value: number): void {
    const a = this.active.get(key);
    if (!a) return;
    if (hit) {
      a.okStreak = 0;
      return;
    }
    if (++a.okStreak >= RESOLVE_STREAK) {
      this.active.delete(key);
      a.alert.state = 'resolved';
      a.alert.resolvedAt = ts;
      if (value) a.alert.value = Math.round(value * 100) / 100;
      this.emit('resolve', a.alert);
    }
  }

  private emit(kind: keyof DetectorListeners, a: AlertDTO): void {
    for (const l of this.listeners) l[kind]?.(a);
  }
}
