// The simulated world (plan §1.3). Single source of truth for services, teams, dependencies and regions.
//
//                 edge-gateway
//                /     |       \
//             auth  catalog-api  orders-api
//             /  \    /   \      /   |    \
//        cache   db  cache db   db  queue  payments
//                                     |
//                                   worker ──> db
//
// Edges point from caller to callee: `dependsOn` lists the services a service calls.
// worker consumes from queue, so worker dependsOn [queue, db]. That keeps queue out of a db fault's blast
// radius (the plan's slow-db cascade is auth, catalog, orders, worker, gateway).

export const TEAMS = ['platform', 'commerce', 'payments', 'data'] as const;
export type Team = (typeof TEAMS)[number];

export const SERVICE_IDS = [
  'edge-gateway',
  'auth',
  'catalog-api',
  'orders-api',
  'payments',
  'worker',
  'db',
  'cache',
  'queue',
] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export interface Dependency {
  service: ServiceId;
  /** Requests to the dependency per request to the caller (load model, §8.9). */
  callFraction: number;
}

export interface ServiceDef {
  id: ServiceId;
  /** svcIdx on the wire = position in SERVICES. */
  idx: number;
  name: string;
  team: Team;
  dependsOn: Dependency[];
  /** Number of simulated nodes (48 total). */
  nodeCount: number;
  /** Latency SLO in ms. Threshold rule: lat > 3 × slo for 5 points → warn. */
  sloMs: number;
  /** Own latency at idle, ms, before dependency latency is added (simulator). */
  baseLatMs: number;
  /** Row for the fixed layered layout (0 = top). */
  layer: number;
}

const def = (
  id: ServiceId,
  name: string,
  team: Team,
  nodeCount: number,
  sloMs: number,
  baseLatMs: number,
  layer: number,
  dependsOn: Dependency[] = [],
): Omit<ServiceDef, 'idx'> => ({ id, name, team, nodeCount, sloMs, baseLatMs, layer, dependsOn });

export const SERVICES: readonly ServiceDef[] = [
  def('edge-gateway', 'Edge Gateway', 'platform', 6, 250, 4, 0, [
    { service: 'auth', callFraction: 1.0 },
    { service: 'catalog-api', callFraction: 0.7 },
    { service: 'orders-api', callFraction: 0.2 },
  ]),
  def('auth', 'Auth', 'platform', 4, 60, 6, 1, [
    { service: 'cache', callFraction: 1.0 },
    { service: 'db', callFraction: 0.1 },
  ]),
  def('catalog-api', 'Catalog API', 'commerce', 6, 120, 12, 1, [
    { service: 'cache', callFraction: 1.5 },
    { service: 'db', callFraction: 0.4 },
  ]),
  def('orders-api', 'Orders API', 'commerce', 6, 200, 15, 1, [
    { service: 'db', callFraction: 2.0 },
    { service: 'queue', callFraction: 1.0 },
    { service: 'payments', callFraction: 0.6 },
  ]),
  def('payments', 'Payments', 'payments', 4, 300, 80, 2),
  def('worker', 'Worker', 'data', 10, 500, 30, 2, [
    { service: 'queue', callFraction: 1.0 },
    { service: 'db', callFraction: 1.5 },
  ]),
  def('db', 'Database', 'data', 4, 20, 4, 3),
  def('cache', 'Cache', 'data', 4, 5, 1, 3),
  def('queue', 'Queue', 'data', 4, 10, 2, 3),
].map((s, idx) => ({ ...s, idx }));

export const SERVICE_BY_ID: Readonly<Record<ServiceId, ServiceDef>> = Object.fromEntries(
  SERVICES.map((s) => [s.id, s]),
) as Record<ServiceId, ServiceDef>;

export const isServiceId = (x: string): x is ServiceId => x in SERVICE_BY_ID;
export const serviceIdx = (id: ServiceId): number => SERVICE_BY_ID[id].idx;
export const teamOfService = (id: ServiceId): Team => SERVICE_BY_ID[id].team;
export const servicesOfTeam = (team: Team): ServiceId[] =>
  SERVICES.filter((s) => s.team === team).map((s) => s.id);

/** Directed edges caller → callee. */
export const EDGES: readonly { from: ServiceId; to: ServiceId; callFraction: number }[] = SERVICES.flatMap((s) =>
  s.dependsOn.map((d) => ({ from: s.id, to: d.service, callFraction: d.callFraction })),
);

// ---------------------------------------------------------------- graph helpers (correlator, topology UI)

/** Direct dependencies (callees). */
export const directDeps = (id: ServiceId): ServiceId[] => SERVICE_BY_ID[id].dependsOn.map((d) => d.service);

/** Direct dependents (callers). */
export const directDependents = (id: ServiceId): ServiceId[] =>
  EDGES.filter((e) => e.to === id).map((e) => e.from);

/** Services adjacent in either edge direction. */
export const neighbours = (id: ServiceId): ServiceId[] => [...new Set([...directDeps(id), ...directDependents(id)])];

function closure(start: ServiceId, next: (id: ServiceId) => ServiceId[]): Set<ServiceId> {
  const out = new Set<ServiceId>();
  const stack = [...next(start)];
  while (stack.length) {
    const s = stack.pop()!;
    if (out.has(s)) continue;
    out.add(s);
    stack.push(...next(s));
  }
  return out;
}

/** dependsOn*(s): everything s transitively calls (excluding s). */
export const transitiveDeps = (id: ServiceId): Set<ServiceId> => closure(id, directDeps);

/** Blast radius: everything that transitively depends on s (excluding s). */
export const transitiveDependents = (id: ServiceId): Set<ServiceId> => closure(id, directDependents);

// ---------------------------------------------------------------- regions + canonical fleet

export const REGIONS = [
  { id: 'us-east-1', azs: ['a', 'b', 'c'] },
  { id: 'eu-west-1', azs: ['a', 'b', 'c'] },
  { id: 'ap-south-1', azs: ['a', 'b', 'c'] },
] as const;
export type RegionId = (typeof REGIONS)[number]['id'];

export interface NodeDef {
  nodeId: string;
  serviceId: ServiceId;
  team: Team;
  region: RegionId;
  /** Full AZ name, e.g. "us-east-1a". */
  az: string;
  /** 1-based index within the service. */
  index: number;
}

/** Node id format: "<region><az>.<service>.<NN>", e.g. "ap-south-1a.orders-api.03". */
export const makeNodeId = (az: string, serviceId: string, index: number): string =>
  `${az}.${serviceId}.${String(index).padStart(2, '0')}`;

/** Parses a node id. Returns null when it is not in the canonical format. */
export function parseNodeId(nodeId: string): { az: string; region: string; serviceId: string; index: number } | null {
  const m = /^([a-z]+-[a-z]+-\d+)([a-z])\.([a-z0-9-]+)\.(\d+)$/.exec(nodeId);
  if (!m) return null;
  return { region: m[1]!, az: m[1]! + m[2]!, serviceId: m[3]!, index: Number(m[4]) };
}

/**
 * The 48 simulated nodes, deterministic order (service order, then index). Nodes of a service are spread
 * round-robin over regions, then AZs. Seed, simulator and server all build the fleet from this.
 *
 * Note: the wire's nodeIdx is assigned by the server's node registry (seeded fleet first, in this order,
 * then dynamically registered nodes such as stress-test nodes) and delivered in GET /topology.
 */
export function buildFleet(): NodeDef[] {
  const nodes: NodeDef[] = [];
  for (const s of SERVICES) {
    for (let i = 0; i < s.nodeCount; i++) {
      const region = REGIONS[i % REGIONS.length]!;
      const azLetter = region.azs[Math.floor(i / REGIONS.length) % region.azs.length]!;
      const az = `${region.id}${azLetter}`;
      nodes.push({
        nodeId: makeNodeId(az, s.id, i + 1),
        serviceId: s.id,
        team: s.team,
        region: region.id,
        az,
        index: i + 1,
      });
    }
  }
  return nodes;
}

/** The simulator runs one logical agent per region; an agent owns node ids starting with its prefix. */
export const agentIdForRegion = (region: RegionId): string => `sim-${region}`;
