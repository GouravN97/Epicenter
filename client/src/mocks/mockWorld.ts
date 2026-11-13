// Deterministic model of the simulated fleet for mock mode.
//
// Every value is a pure function of (node, second). That is the point: the mock REST history and the mock
// live stream compute the same point for the same (nodeId, ts), exactly like the real backend where both
// come from one stored bucket. So history/live merge, gap-fill and replay can be built and tested against
// the mock and behave the same against the real server.
//
// Faults repeat on a fixed schedule (see FAULT_CYCLE) so there is always something to look at.
import {
  REGIONS,
  SERVICES,
  makeNodeId,
  round1,
  type MetricValues,
  type RegionId,
  type ServiceId,
  type Team,
} from '@epicenter/shared';

export interface MockNode {
  /** Index used on the wire (position in the fleet). */
  idx: number;
  nodeId: string;
  serviceId: ServiceId;
  svcIdx: number;
  team: Team;
  region: RegionId;
  az: string;
}

export type FaultKind = 'slow-db' | 'cpu-spike' | 'cache-outage' | 'node-kill';

export interface Fault {
  kind: FaultKind;
  /** Cycle number; unique per fault occurrence. */
  cycle: number;
  startSec: number;
  endSec: number;
  /** The service where the fault originates (the expected epicenter). */
  service: ServiceId;
  /** Target node for node-scoped faults, else null. */
  nodeIdx: number | null;
  /** 0–1, ramps up at the start and down at the end. */
  intensity: number;
}

/** One fault per cycle: starts at FAULT_START seconds into the cycle and lasts until FAULT_END. */
export const FAULT_CYCLE = 240;
export const FAULT_START = 90;
export const FAULT_END = 165;
const FAULT_RAMP = 8;
/** Order of faults across cycles; `null` is a quiet cycle. */
const FAULT_ORDER: (FaultKind | null)[] = ['slow-db', 'cpu-spike', 'cache-outage', 'node-kill', null];

const TOTAL_SEED_NODES = SERVICES.reduce((n, s) => n + s.nodeCount, 0);

/** Integer hash → [0, 1). */
function hash(a: number, b: number, c: number): number {
  let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  x = Math.imul(x ^ (x >>> 13), 1103515245);
  x ^= x >>> 16;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) that changes over `period` seconds. */
function smooth(a: number, t: number, period: number, salt: number): number {
  const k = Math.floor(t / period);
  const f = t / period - k;
  const s = f * f * (3 - 2 * f);
  return hash(a, k, salt) * (1 - s) + hash(a, k + 1, salt) * s;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

interface ServiceModel {
  rps: number[];
  lat: number[];
  err: number[];
  cpu: number[];
}

export interface MockWorld {
  nodes: readonly MockNode[];
  nodeById: ReadonlyMap<string, MockNode>;
  /** Number of nodes per service, indexed by svcIdx. */
  nodeCounts: readonly number[];
  /** The fault active at `tSec`, or null. */
  faultAt(tSec: number): Fault | null;
  /**
   * The 1-second point for a node, or null when the node is not reporting (node-kill).
   * `withFault = false` gives the same instant with no fault: the baseline the mock detector compares with.
   */
  pointAt(nodeIdx: number, tSec: number, withFault?: boolean): MetricValues | null;
}

/** Builds the fleet. 48 nodes gives exactly the canonical fleet from `buildFleet()`; other totals scale it. */
export function buildMockFleet(total = TOTAL_SEED_NODES): MockNode[] {
  const scale = total / TOTAL_SEED_NODES;
  const nodes: MockNode[] = [];
  for (const s of SERVICES) {
    const count = Math.max(1, Math.round(s.nodeCount * scale));
    for (let i = 0; i < count; i++) {
      const region = REGIONS[i % REGIONS.length]!;
      const azLetter = region.azs[Math.floor(i / REGIONS.length) % region.azs.length]!;
      const az = `${region.id}${azLetter}`;
      nodes.push({
        idx: nodes.length,
        nodeId: makeNodeId(az, s.id, i + 1),
        serviceId: s.id,
        svcIdx: s.idx,
        team: s.team,
        region: region.id,
        az,
      });
    }
  }
  return nodes;
}

export function createMockWorld(totalNodes = TOTAL_SEED_NODES): MockWorld {
  const nodes = buildMockFleet(totalNodes);
  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  const nodeCounts = SERVICES.map((s) => nodes.filter((n) => n.svcIdx === s.idx).length);
  const firstNodeOf = (id: ServiceId): number => nodes.find((n) => n.serviceId === id)!.idx;

  function faultAt(tSec: number): Fault | null {
    const cycle = Math.floor(tSec / FAULT_CYCLE);
    const phase = tSec - cycle * FAULT_CYCLE;
    if (phase < FAULT_START || phase >= FAULT_END) return null;
    const kind = FAULT_ORDER[cycle % FAULT_ORDER.length];
    if (!kind) return null;

    const startSec = cycle * FAULT_CYCLE + FAULT_START;
    const endSec = cycle * FAULT_CYCLE + FAULT_END;
    const ramp = kind === 'node-kill' ? 1 : clamp(Math.min(tSec - startSec + 1, endSec - tSec) / FAULT_RAMP, 0, 1);

    let service: ServiceId;
    let nodeIdx: number | null = null;
    if (kind === 'slow-db') service = 'db';
    else if (kind === 'cache-outage') service = 'cache';
    else {
      // Node-scoped faults pick a node of a leaf-ish service so the picture is unambiguous.
      const candidates: ServiceId[] = kind === 'cpu-spike' ? ['payments', 'catalog-api', 'worker'] : ['worker', 'payments', 'auth'];
      service = candidates[Math.floor(hash(cycle, 11, 1) * candidates.length)]!;
      const count = nodeCounts[SERVICES.findIndex((s) => s.id === service)]!;
      nodeIdx = firstNodeOf(service) + Math.floor(hash(cycle, 12, 2) * count);
    }
    return { kind, cycle, startSec, endSec, service, nodeIdx, intensity: ramp };
  }

  // Service-level model, cached per (second, fault on/off): every node of a tick shares it.
  const cache = new Map<number, ServiceModel>();

  function serviceModel(tSec: number, fault: Fault | null): ServiceModel {
    const key = tSec * 2 + (fault ? 1 : 0);
    const hit = cache.get(key);
    if (hit) return hit;

    const n = SERVICES.length;
    // Gateway load: slow daily-style wave plus wander. 0.3–1.0.
    const load = clamp(0.65 + 0.25 * Math.sin((2 * Math.PI * tSec) / 900) + 0.2 * (smooth(900, tSec, 20, 1) - 0.5), 0.3, 1);
    const gatewayRps = 600 * load;

    // Requests flow down the dependency edges. SERVICES lists callers before their callees.
    const rps = new Array<number>(n).fill(0);
    rps[0] = gatewayRps;
    rps[SERVICES.findIndex((s) => s.id === 'worker')]! += 0.3 * gatewayRps; // background jobs
    for (const s of SERVICES) for (const d of s.dependsOn) rps[SERVICES.findIndex((x) => x.id === d.service)]! += rps[s.idx]! * d.callFraction;

    const cpu = SERVICES.map((s) => 22 + 40 * load + (fault?.kind === 'slow-db' && s.id === 'db' ? 25 * fault.intensity : 0));

    // Latency and errors propagate up from the dependencies, so walk callees first.
    const lat = new Array<number>(n).fill(0);
    const err = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      const s = SERVICES[i]!;
      let ownLat = s.baseLatMs * (1 + Math.max(0, cpu[i]! - 50) / 40);
      if (fault?.kind === 'slow-db' && s.id === 'db') ownLat *= 1 + 27 * fault.intensity;
      let ownErr = 0.15;
      if (fault?.kind === 'cache-outage' && s.id === 'cache') ownErr += 60 * fault.intensity;
      let depLat = 0;
      let depErr = 0;
      for (const d of s.dependsOn) {
        const j = SERVICES.findIndex((x) => x.id === d.service);
        depLat += d.callFraction * lat[j]!;
        depErr += Math.min(1, d.callFraction) * err[j]!;
      }
      lat[i] = ownLat + depLat;
      err[i] = clamp(ownErr + 0.5 * depErr, 0, 100);
    }

    const model = { rps, lat, err, cpu };
    if (cache.size > 8000) cache.clear();
    cache.set(key, model);
    return model;
  }

  function pointAt(nodeIdx: number, tSec: number, withFault = true): MetricValues | null {
    const node = nodes[nodeIdx];
    if (!node) return null;
    const fault = withFault ? faultAt(tSec) : null;
    const onThisNode = fault?.nodeIdx === nodeIdx;
    if (fault?.kind === 'node-kill' && onThisNode) return null;

    const m = serviceModel(tSec, fault);
    const s = node.svcIdx;
    const offset = hash(nodeIdx, 7, 1); // stable per-node character

    const cpu =
      m.cpu[s]! +
      (offset - 0.5) * 14 +
      (smooth(nodeIdx, tSec, 12, 2) - 0.5) * 10 +
      (hash(nodeIdx, tSec, 3) - 0.5) * 2.4 +
      (fault?.kind === 'cpu-spike' && onThisNode ? 60 * fault.intensity : 0);
    const mem = 38 + hash(nodeIdx, 7, 4) * 30 + (smooth(nodeIdx, tSec, 300, 5) - 0.5) * 8 + (hash(nodeIdx, tSec, 6) - 0.5) * 0.6;
    const disk = 30 + hash(nodeIdx, 7, 7) * 45 + smooth(nodeIdx, tSec, 1800, 8) * 3;
    const rps = (m.rps[s]! / nodeCounts[s]!) * (0.92 + 0.16 * smooth(nodeIdx, tSec, 15, 9));
    const lat = m.lat[s]! * (0.9 + 0.2 * smooth(nodeIdx, tSec, 9, 10)) + (hash(nodeIdx, tSec, 11) - 0.5) * 0.4;
    const err = m.err[s]! * (0.8 + 0.4 * smooth(nodeIdx, tSec, 11, 12));
    const netIn = 20 + rps * 2.2 * (0.95 + 0.1 * hash(nodeIdx, tSec, 13));
    const netOut = 30 + rps * 5.5 * (0.95 + 0.1 * hash(nodeIdx, tSec, 14));

    return {
      cpu: round1(clamp(cpu, 0, 100)),
      mem: round1(clamp(mem, 0, 100)),
      disk: round1(clamp(disk, 0, 100)),
      netIn: round1(Math.max(0, netIn)),
      netOut: round1(Math.max(0, netOut)),
      lat: round1(Math.max(0, lat)),
      err: round1(clamp(err, 0, 100)),
      rps: round1(Math.max(0, rps)),
    };
  }

  return { nodes, nodeById, nodeCounts, faultAt, pointAt };
}
