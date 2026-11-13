// The ShopStream load model (plan §8.9). Load enters at edge-gateway, flows down the dependency edges by
// call fraction, and latency and errors flow back up. Because the propagation is computed, a fault at one
// service (A8 chaos sets `effects`) produces a cascade without any scripting.
import {
  SERVICES,
  SERVICE_BY_ID,
  buildFleet,
  type MetricValues,
  type NodeDef,
  type ServiceId,
} from '@epicenter/shared';

// ---------------------------------------------------------------- randomness

/** Small seeded PRNG so tests are deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ---------------------------------------------------------------- model parameters

/** Total gateway requests/s at the middle of the daily curve. */
export const NOMINAL_GATEWAY_RPS = 1200;

interface ServiceParams {
  /** cpu at nominal load, % (k is derived from it so every service idles at a believable level). */
  nominalCpu: number;
  /** kB in / out per request. */
  inKB: number;
  outKB: number;
  /** Background error rate, %. */
  baseErr: number;
}

const PARAMS: Record<ServiceId, ServiceParams> = {
  'edge-gateway': { nominalCpu: 35, inKB: 2, outKB: 8, baseErr: 0.1 },
  auth: { nominalCpu: 40, inKB: 0.5, outKB: 0.5, baseErr: 0.05 },
  'catalog-api': { nominalCpu: 45, inKB: 1, outKB: 12, baseErr: 0.1 },
  'orders-api': { nominalCpu: 40, inKB: 2, outKB: 3, baseErr: 0.15 },
  payments: { nominalCpu: 30, inKB: 1.5, outKB: 1, baseErr: 0.2 },
  worker: { nominalCpu: 50, inKB: 2, outKB: 1, baseErr: 0.1 },
  db: { nominalCpu: 45, inKB: 0.5, outKB: 4, baseErr: 0.02 },
  cache: { nominalCpu: 25, inKB: 0.2, outKB: 2, baseErr: 0.01 },
  queue: { nominalCpu: 20, inKB: 1, outKB: 1, baseErr: 0.02 },
};

const CPU_IDLE = 5;
/** Above this cpu a node starts shedding errors. */
const CPU_ERR_KNEE = 85;
/** Share of a dependency's error rate that surfaces in its caller (per unit of call fraction, capped at 1). */
const ERR_PROPAGATION = 0.8;
const DAY_MS = 86_400_000;
const WAVE_MS = 300_000;

// ---------------------------------------------------------------- effects (filled by chaos in A8)

export interface ServiceEffect {
  latMul?: number;
  errAdd?: number;
  cpuAdd?: number;
}
export interface NodeEffect {
  cpuAdd?: number;
  /** cpu never drops below this (a runaway process pins the CPU). */
  cpuFloor?: number;
  /** mem % added per second while active (memory leak). */
  memRate?: number;
  /** Node stops emitting. */
  killed?: boolean;
}
export interface Effects {
  /** Multiplier on gateway traffic. */
  rpsMul: number;
  service: Partial<Record<ServiceId, ServiceEffect>>;
  node: Record<string, NodeEffect>;
}
export const noEffects = (): Effects => ({ rpsMul: 1, service: {}, node: {} });

// ---------------------------------------------------------------- service load (pure)

/**
 * Requests/s arriving at each service for a given gateway load. Callers are summed by call fraction.
 * worker has no callers: it consumes what other services publish to queue, so its load is the queue's
 * inbound rate from non-worker publishers; queue then also serves worker's reads.
 */
export function serviceLoads(gatewayRps: number): Record<ServiceId, number> {
  const memo = new Map<ServiceId, number>();
  const load = (id: ServiceId): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    let v: number;
    if (id === 'edge-gateway') v = gatewayRps;
    else if (id === 'worker') {
      v = SERVICES.filter((s) => s.id !== 'worker')
        .flatMap((s) => s.dependsOn.filter((d) => d.service === 'queue').map((d) => load(s.id) * d.callFraction))
        .reduce((a, b) => a + b, 0);
    } else {
      v = SERVICES.flatMap((s) => s.dependsOn.filter((d) => d.service === id).map((d) => load(s.id) * d.callFraction)).reduce(
        (a, b) => a + b,
        0,
      );
    }
    memo.set(id, v);
    return v;
  };
  return Object.fromEntries(SERVICES.map((s) => [s.id, load(s.id)])) as Record<ServiceId, number>;
}

/** Queueing-style latency multiplier: ×2 at 50% cpu, ×10 at 90%, capped at ×33. */
export const latencyFactor = (cpu: number): number => 1 / (1 - Math.min(cpu, 97) / 100);

/** Gateway traffic at a wall-clock time: daily sine + a 5-minute wave so the demo visibly moves. */
export const trafficCurve = (now: number): number =>
  NOMINAL_GATEWAY_RPS * (1 + 0.25 * Math.sin((2 * Math.PI * (now % DAY_MS)) / DAY_MS) + 0.1 * Math.sin((2 * Math.PI * now) / WAVE_MS));

// ---------------------------------------------------------------- world

interface NodeState {
  def: NodeDef;
  /** Fixed per-node load-balancer weight around 1. */
  weight: number;
  cpuNoise: number;
  memBase: number;
  /** memBase at boot; a restart returns to it. */
  memBase0: number;
  mem: number;
  disk: number;
  last: MetricValues;
}

export interface Sample {
  nodeId: string;
  m: MetricValues;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const clampPct = (x: number): number => Math.min(100, Math.max(0, x));

export class World {
  readonly nodes: NodeState[];
  readonly byService: Map<ServiceId, NodeState[]> = new Map();
  effects: Effects = noEffects();
  /** cpu per rps-per-node, derived from nominal load. */
  private readonly cpuK: Record<ServiceId, number>;
  private readonly rand: () => number;

  constructor(opts: { seed?: number; fleet?: NodeDef[] } = {}) {
    this.rand = mulberry32(opts.seed ?? Date.now());
    const fleet = opts.fleet ?? buildFleet();
    this.nodes = fleet.map((def) => {
      const memBase = 35 + this.rand() * 25;
      return {
        def,
        weight: 0.9 + this.rand() * 0.2,
        cpuNoise: 0,
        memBase,
        memBase0: memBase,
        mem: memBase,
        disk: 20 + this.rand() * 45,
        last: { cpu: 0, mem: memBase, disk: 0, netIn: 0, netOut: 0, lat: 0, err: 0, rps: 0 },
      };
    });
    for (const n of this.nodes) {
      const list = this.byService.get(n.def.serviceId) ?? [];
      list.push(n);
      this.byService.set(n.def.serviceId, list);
    }
    const nominal = serviceLoads(NOMINAL_GATEWAY_RPS);
    this.cpuK = Object.fromEntries(
      SERVICES.map((s) => [s.id, (PARAMS[s.id].nominalCpu - CPU_IDLE) / (nominal[s.id] / s.nodeCount)]),
    ) as Record<ServiceId, number>;
  }

  /** A process restart: memory returns to its boot level (used when a memory leak is "fixed"). */
  resetNode(nodeId: string): void {
    const n = this.nodes.find((x) => x.def.nodeId === nodeId);
    if (!n) return;
    n.memBase = n.memBase0;
    n.mem = n.memBase0;
    n.cpuNoise = 0;
  }

  /** Advances the model by dtSec and returns one sample per live node. */
  step(now: number, dtSec: number): Sample[] {
    const noise = () => gaussian(this.rand);
    const loads = serviceLoads(trafficCurve(now) * this.effects.rpsMul * (1 + 0.02 * noise()));

    // Pass 1, top-down quantities: rps, cpu, mem, disk, network.
    for (const n of this.nodes) {
      const svc = SERVICE_BY_ID[n.def.serviceId];
      const p = PARAMS[svc.id];
      const se = this.effects.service[svc.id] ?? {};
      const ne = this.effects.node[n.def.nodeId] ?? {};
      const totalWeight = this.byService.get(svc.id)!.reduce((a, x) => a + x.weight, 0);
      const rps = (loads[svc.id] * n.weight) / totalWeight;

      // Ornstein–Uhlenbeck noise keeps cpu wandering without drifting away.
      n.cpuNoise += -0.3 * n.cpuNoise * dtSec + 2.5 * Math.sqrt(dtSec) * noise();
      const cpu = clampPct(
        Math.max(ne.cpuFloor ?? 0, CPU_IDLE + this.cpuK[svc.id] * rps + n.cpuNoise + (se.cpuAdd ?? 0) + (ne.cpuAdd ?? 0)),
      );

      n.mem += 0.01 * (n.memBase - n.mem) * dtSec + 0.3 * Math.sqrt(dtSec) * noise() + (ne.memRate ?? 0) * dtSec;
      if (ne.memRate) n.memBase = Math.max(n.memBase, n.mem); // a leak does not heal itself
      n.mem = clampPct(n.mem);
      n.disk = clampPct(n.disk + 0.0005 * dtSec + 0.02 * noise());

      n.last = {
        cpu,
        mem: n.mem,
        disk: n.disk,
        netIn: Math.max(0, rps * p.inKB * (1 + 0.05 * noise())),
        netOut: Math.max(0, rps * p.outKB * (1 + 0.05 * noise())),
        lat: 0,
        err: 0,
        rps,
      };
    }

    // Pass 2, bottom-up: latency and errors include the callee's, so compute dependencies first.
    const svcLat = new Map<ServiceId, number>();
    const svcErr = new Map<ServiceId, number>();
    const visit = (id: ServiceId): void => {
      if (svcLat.has(id)) return;
      const deps = SERVICE_BY_ID[id].dependsOn;
      for (const d of deps) visit(d.service);
      const se = this.effects.service[id] ?? {};
      const depLat = deps.reduce((a, d) => a + d.callFraction * svcLat.get(d.service)!, 0);
      const depErr = deps.reduce((a, d) => a + Math.min(1, d.callFraction) * ERR_PROPAGATION * svcErr.get(d.service)!, 0);
      const nodes = this.byService.get(id)!;
      let latSum = 0;
      let errSum = 0;
      for (const n of nodes) {
        const own = SERVICE_BY_ID[id].baseLatMs * latencyFactor(n.last.cpu) * (se.latMul ?? 1);
        n.last.lat = Math.max(0, (own + depLat) * (1 + 0.05 * noise()));
        const overload = n.last.cpu > CPU_ERR_KNEE ? (n.last.cpu - CPU_ERR_KNEE) * 1.5 : 0;
        n.last.err = clampPct(PARAMS[id].baseErr * (1 + 0.5 * Math.abs(noise())) + overload + depErr + (se.errAdd ?? 0));
        latSum += n.last.lat;
        errSum += n.last.err;
      }
      svcLat.set(id, latSum / nodes.length);
      svcErr.set(id, errSum / nodes.length);
    };
    for (const s of SERVICES) visit(s.id);

    return this.nodes
      .filter((n) => !this.effects.node[n.def.nodeId]?.killed)
      .map((n) => ({
        nodeId: n.def.nodeId,
        m: {
          cpu: r2(n.last.cpu),
          mem: r2(n.last.mem),
          disk: r2(n.last.disk),
          netIn: r2(n.last.netIn),
          netOut: r2(n.last.netOut),
          lat: r2(n.last.lat),
          err: r2(n.last.err),
          rps: r2(n.last.rps),
        },
      }));
  }
}

/** Mean of each metric per service, for logs and tests. */
export function serviceSummary(samples: Sample[]): Record<string, MetricValues> {
  const acc: Record<string, { n: number; m: MetricValues }> = {};
  for (const s of samples) {
    const svc = s.nodeId.split('.')[1]!;
    const a = (acc[svc] ??= { n: 0, m: { cpu: 0, mem: 0, disk: 0, netIn: 0, netOut: 0, lat: 0, err: 0, rps: 0 } });
    a.n++;
    for (const k of Object.keys(a.m) as (keyof MetricValues)[]) a.m[k] += s.m[k];
  }
  return Object.fromEntries(
    Object.entries(acc).map(([svc, { n, m }]) => [
      svc,
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / n])) as MetricValues,
    ]),
  );
}
