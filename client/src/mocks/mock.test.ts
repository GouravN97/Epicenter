import { describe, expect, it } from 'vitest';
import { METRICS, NodeStatus, buildFleet, type DashS2C, type FleetDelta, type NodePt, type SubAck, type TopoTick, type UserDTO } from '@epicenter/shared';
import { MockBackend, MOCK_LAG_SEC } from './mockBackend';
import { MockSocket } from './mockSocket';
import { FAULT_CYCLE, FAULT_END, FAULT_START, createMockWorld } from './mockWorld';

const admin: UserDTO = { id: 'a', email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: ['platform', 'commerce', 'payments', 'data'] };
const viewer: UserDTO = { id: 'v', email: 'payments@epicenter.dev', name: 'Viewer', role: 'viewer', teams: ['payments'] };

// Cycle 0 of the fault schedule is slow-db. Pick a cycle number that is a multiple of 5 and far from zero.
const CYCLE0 = 5 * 1_000_000 * FAULT_CYCLE;
const SLOW_DB_START = CYCLE0 + FAULT_START;
const NODE_KILL_START = CYCLE0 + 3 * FAULT_CYCLE + FAULT_START;

/** A backend whose clock the test controls. `at(sec)` processes every second up to `sec`. */
function harness(startSec: number, nodes?: number) {
  let nowSec = startSec + MOCK_LAG_SEC;
  const backend = new MockBackend({ nodes, now: () => nowSec * 1000 });
  backend.advance();
  return {
    backend,
    at(sec: number) {
      nowSec = sec + MOCK_LAG_SEC;
      backend.advance();
    },
  };
}

function connect(backend: MockBackend, user: UserDTO) {
  const socket = new MockSocket(backend, user, 't', { latencyMs: 0 });
  const got: { [E in keyof DashS2C]?: Parameters<DashS2C[E]>[0][] } = {};
  const record = (e: keyof DashS2C) => socket.on(e, ((p: never) => ((got[e] as unknown[] | undefined) ?? ((got[e] as unknown[]) = [])).push(p)) as never);
  (['fleet:delta', 'topo:tick', 'node:pt', 'alert:new', 'alert:upd', 'incident:new', 'incident:upd'] as const).forEach(record);
  socket.connect();
  const sub = (rooms: string[]): SubAck => {
    let ack!: SubAck;
    socket.emit('sub', { rooms }, (r) => (ack = r));
    return ack;
  };
  return { socket, got, sub };
}

describe('mock world', () => {
  it('uses the canonical 48-node fleet and scales on request', () => {
    const w = createMockWorld();
    expect(w.nodes.map((n) => n.nodeId)).toEqual(buildFleet().map((n) => n.nodeId));
    expect(createMockWorld(500).nodes.length).toBeGreaterThan(480);
  });

  it('is a pure function of (node, second), with every metric in range', () => {
    const a = createMockWorld();
    const b = createMockWorld();
    for (let t = CYCLE0; t < CYCLE0 + FAULT_CYCLE; t += 7) {
      for (const n of a.nodes) {
        const p = a.pointAt(n.idx, t)!;
        expect(p).toEqual(b.pointAt(n.idx, t));
        for (const m of METRICS) expect(Number.isFinite(p[m]) && p[m] >= 0).toBe(true);
        for (const m of ['cpu', 'mem', 'disk', 'err'] as const) expect(p[m]).toBeLessThanOrEqual(100);
      }
    }
  });

  it('slow-db raises latency on db and cascades to its dependents, not to payments', () => {
    const w = createMockWorld();
    const t = SLOW_DB_START + 30;
    expect(w.scheduledAt(t)).toMatchObject({ kind: 'slow-db', service: 'db' });
    const rise = (svc: string) => {
      const n = w.nodes.find((x) => x.serviceId === svc)!;
      return w.pointAt(n.idx, t)!.lat - w.pointAt(n.idx, t, false)!.lat;
    };
    expect(rise('db')).toBeGreaterThan(40);
    expect(rise('orders-api')).toBeGreaterThan(40);
    expect(rise('edge-gateway')).toBeGreaterThan(40);
    expect(Math.abs(rise('payments'))).toBeLessThan(1);
    expect(w.scheduledAt(CYCLE0 + FAULT_END)).toBeNull();
  });

  it('node-kill makes one node stop reporting', () => {
    const w = createMockWorld();
    const f = w.scheduledAt(NODE_KILL_START + 10)!;
    expect(f.kind).toBe('node-kill');
    expect(w.pointAt(f.nodeIdx!, NODE_KILL_START + 10)).toBeNull();
    expect(w.pointAt(f.nodeIdx!, NODE_KILL_START - 1)).not.toBeNull();
  });
});

describe('mock backend', () => {
  it('groups a slow-db cascade into one incident with epicenter db, then resolves it', () => {
    const h = harness(SLOW_DB_START - 5);
    const { got, sub } = connect(h.backend, admin);
    sub(['fleet:*']); // alerts rooms are separate from fleet rooms
    sub(['alerts:data', 'alerts:commerce', 'alerts:platform']);

    h.at(SLOW_DB_START + 40);
    const open = h.backend.incidentList(admin).filter((i) => i.state === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ epicenter: 'db', confidence: 1 });
    expect(open[0]!.affected).toEqual(expect.arrayContaining(['db', 'orders-api', 'worker', 'edge-gateway']));
    expect(open[0]!.blastRadius).toEqual(expect.arrayContaining(['auth', 'catalog-api', 'orders-api', 'worker', 'edge-gateway']));
    const during = h.backend.alerts(admin, { limit: 200 }).filter((a) => a.startedAt >= SLOW_DB_START * 1000);
    expect(during.length).toBeGreaterThan(10);
    expect(during.every((a) => a.incidentId === open[0]!.id)).toBe(true);
    expect(got['alert:new']!.length).toBe(during.length);

    h.at(CYCLE0 + FAULT_END + 60);
    expect(h.backend.incidentList(admin)[0]).toMatchObject({ state: 'resolved' });
    expect(h.backend.alerts(admin, { state: 'firing' })).toHaveLength(0);
    expect(got['alert:upd']!.some((a) => a.state === 'resolved')).toBe(true);
  });

  it('marks a killed node silent and recovers it', () => {
    const h = harness(NODE_KILL_START - 5);
    const target = h.backend.world.scheduledAt(NODE_KILL_START + 1)!.nodeIdx!;
    h.at(NODE_KILL_START + 12);
    expect(h.backend.frame!.status[target]).toBe(NodeStatus.silent);
    expect(h.backend.alerts(admin, { state: 'firing' })[0]).toMatchObject({ rule: 'heartbeat', severity: 'crit' });
    h.at(NODE_KILL_START - FAULT_START + FAULT_END + 5);
    expect(h.backend.frame!.status[target]).toBe(NodeStatus.ok);
  });

  it('serves history that is sorted, unique, and identical to what the live stream sent', () => {
    const h = harness(CYCLE0 + 20);
    const node = h.backend.world.nodes[10]!;
    const { got, sub } = connect(h.backend, admin);
    sub([`node:${node.nodeId}`]);
    h.at(CYCLE0 + 50);

    const live = got['node:pt'] as NodePt[];
    expect(live).toHaveLength(30);
    const hist = h.backend.nodeSeries(admin, node.nodeId, (CYCLE0 + 10) * 1000, (CYCLE0 + 500) * 1000);
    expect(hist.res).toBe('1s');
    expect(hist.t.at(-1)).toBe((CYCLE0 + 50) * 1000); // nothing newer than the last finalized second
    expect(hist.t).toEqual([...new Set(hist.t)].sort((a, b) => a - b));
    for (const pt of live) {
      const i = hist.t.indexOf(pt[1]);
      expect([hist.cpu[i], hist.mem[i], hist.lat[i], hist.rps[i]]).toEqual([pt[2], pt[3], pt[7], pt[9]]);
    }
    expect(h.backend.nodeSeries(admin, node.nodeId, (CYCLE0 - 7200) * 1000, (CYCLE0 + 50) * 1000).res).toBe('1m');
  });
});

describe('mock socket', () => {
  it('sends one full fleet:delta after sub, then only changed nodes', () => {
    const h = harness(CYCLE0 + 20);
    const { got, sub } = connect(h.backend, admin);
    expect(sub(['fleet:data'])).toEqual({ joined: ['fleet:data'], denied: [] });

    const dataNodes = h.backend.world.nodes.filter((n) => n.team === 'data');
    const first = got['fleet:delta']![0] as FleetDelta;
    expect(first.length - 1).toBe(dataNodes.length);
    expect(first[0]).toBe(CYCLE0 + 20);

    h.at(CYCLE0 + 30);
    const later = got['fleet:delta']!.slice(1) as FleetDelta[];
    expect(later.length).toBeGreaterThan(0);
    const last = new Map(first.slice(1).map((r) => [(r as number[])[0], r as number[]]));
    for (const d of later) {
      expect(d.length - 1).toBeLessThan(dataNodes.length);
      for (const row of d.slice(1) as number[][]) {
        const prev = last.get(row[0])!;
        expect(dataNodes.some((n) => n.idx === row[0])).toBe(true);
        expect(row.every(Number.isInteger)).toBe(true);
        expect(prev[1] !== row[1] || prev[2] !== row[2] || prev[3] !== row[3]).toBe(true);
        last.set(row[0], row);
      }
    }
  });

  it('applies the access rule: a viewer only joins rooms of their own teams', () => {
    const h = harness(CYCLE0 + 20);
    const paymentsNode = h.backend.world.nodes.find((n) => n.team === 'payments')!.nodeId;
    const dbNode = h.backend.world.nodes.find((n) => n.serviceId === 'db')!.nodeId;
    const { socket, got, sub } = connect(h.backend, viewer);

    expect(sub(['fleet:*', 'topology', `node:${paymentsNode}`, `node:${dbNode}`, 'fleet:data', 'alerts:data', 'service:db', 'bogus'])).toEqual({
      joined: ['fleet:payments', 'topology', `node:${paymentsNode}`],
      denied: [`node:${dbNode}`, 'fleet:data', 'alerts:data', 'service:db', 'bogus'],
    });
    h.at(CYCLE0 + 25);
    const paymentsIdx = new Set(h.backend.world.nodes.filter((n) => n.team === 'payments').map((n) => n.idx));
    for (const d of got['fleet:delta'] as FleetDelta[]) for (const row of d.slice(1) as number[][]) expect(paymentsIdx.has(row[0]!)).toBe(true);
    expect((got['topo:tick']![0] as TopoTick).length - 1).toBe(9);
    expect(h.backend.topology(viewer).nodes.every((n) => paymentsIdx.has(n[0]))).toBe(true);
    expect(() => h.backend.nodeSeries(viewer, dbNode, 0, 1000)).toThrow(/another team/);
    expect(socket.joinedRooms()).toHaveLength(3);
  });

  it('loses its rooms on a dropped connection and stops delivering after unsub', () => {
    const h = harness(CYCLE0 + 20);
    const { socket, got, sub } = connect(h.backend, admin);
    sub(['topology']);
    h.at(CYCLE0 + 22);
    expect(got['topo:tick']).toHaveLength(2);

    socket.emit('unsub', { rooms: ['topology'] }, () => {});
    h.at(CYCLE0 + 24);
    expect(got['topo:tick']).toHaveLength(2);

    sub(['topology']);
    let reason = '';
    socket.on('disconnect', ((r: string) => (reason = r)) as never);
    socket.drop(60_000);
    expect(reason).toBe('transport close');
    expect(socket.connected).toBe(false);
    expect(socket.joinedRooms()).toEqual([]);
    h.at(CYCLE0 + 26);
    expect(got['topo:tick']).toHaveLength(2);
    socket.disconnect();
  });
});
