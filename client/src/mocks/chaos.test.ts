import { describe, expect, it } from 'vitest';
import { CHAOS_SCENARIOS, NodeStatus, type ChaosUpd, type UserDTO } from '@epicenter/shared';
import { MockBackend, MOCK_LAG_SEC } from './mockBackend';
import { MockSocket } from './mockSocket';
import { FAULT_CYCLE, FAULT_START } from './mockWorld';

const admin: UserDTO = { id: 'a', email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: ['platform', 'commerce', 'payments', 'data'] };
const sre: UserDTO = { id: 's', email: 'sre@epicenter.dev', name: 'SRE', role: 'sre', teams: ['platform', 'commerce', 'payments', 'data'] };
// Cycle index 4 of the background schedule is quiet, so nothing else is going on.
const QUIET = (5 * 1_000_000 + 4) * FAULT_CYCLE + 10;

function harness(startSec = QUIET) {
  let nowSec = startSec + MOCK_LAG_SEC;
  const be = new MockBackend({ now: () => nowSec * 1000 });
  be.advance();
  return {
    be,
    at(sec: number) {
      nowSec = sec + MOCK_LAG_SEC;
      be.advance();
    },
  };
}

function runAndDetect(target: string | undefined, scenario: string, seconds = 40) {
  const h = harness();
  const run = h.be.chaosStart(admin, { scenario: scenario as never, target, durationSec: 120 });
  h.at(QUIET + seconds);
  const inc = h.be.incidentList(admin).find((i) => i.startedAt >= run.endsAt - 120_000);
  const card = h.be.chaosRuns(admin)[0]!;
  return { h, run, inc, card };
}

describe('chaos runs in the mock', () => {
  it('slowing a service other than db is traced back to that service and scored correct', () => {
    const { inc, card } = runAndDetect('auth', 'slow-db');
    expect(inc?.epicenter).toBe('auth');
    expect(inc?.blastRadius).toEqual(['edge-gateway']);
    expect(card).toMatchObject({ scenario: 'slow-db', target: 'auth', detectedEpicenter: 'auth', correct: true, incidentId: inc!.id });
    expect(card.timeToDetectMs).toBeGreaterThan(0);
    expect(card.timeToDetectMs).toBeLessThan(15_000);
  });

  it('a cache outage cascades into auth and catalog with the epicenter on cache', () => {
    const { inc, card } = runAndDetect('cache', 'cache-outage');
    expect(inc?.epicenter).toBe('cache');
    expect(inc?.affected).toEqual(expect.arrayContaining(['cache', 'auth', 'catalog-api']));
    expect(card.correct).toBe(true);
  });

  it('a CPU spike on one node is a single-service incident on that node', () => {
    const h0 = harness();
    const node = h0.be.world.nodes.find((n) => n.serviceId === 'payments')!.nodeId;
    const { inc, card } = runAndDetect(node, 'cpu-spike');
    expect(inc?.epicenter).toBe('payments');
    expect(inc?.affected).toEqual(['payments']);
    expect(card).toMatchObject({ target: node, correct: true });
  });

  it('a killed node goes silent within a few seconds and comes back when stopped', () => {
    const h = harness();
    const node = h.be.world.nodes.find((n) => n.serviceId === 'worker')!;
    const run = h.be.chaosStart(admin, { scenario: 'node-kill', target: node.nodeId, durationSec: 300 });
    h.at(QUIET + 9);
    expect(h.be.frame!.status[node.idx]).toBe(NodeStatus.silent);
    h.be.chaosStop(admin, run.runId);
    h.at(QUIET + 15);
    expect(h.be.frame!.points[node.idx]).not.toBeNull();
    expect(h.be.frame!.status[node.idx]).toBe(NodeStatus.ok);
    expect(h.be.chaosActive().active).toEqual([]);
  });

  it('a memory leak climbs steadily and alerts on memory', () => {
    const h = harness();
    const node = h.be.world.nodes.find((n) => n.serviceId === 'catalog-api')!;
    h.be.chaosStart(admin, { scenario: 'memory-leak', target: node.nodeId, durationSec: 240 });
    const mem0 = h.be.world.pointAt(node.idx, QUIET + 1)!.mem;
    h.at(QUIET + 80);
    expect(h.be.frame!.points[node.idx]!.mem - mem0).toBeGreaterThan(15);
    expect(h.be.alerts(admin, { state: 'firing' }).some((a) => a.nodeId === node.nodeId && a.metric === 'mem')).toBe(true);
  });

  it('traffic surge, duplicate storm and malformed flood move the pipeline counters, and are not scored', () => {
    for (const [scenario, check] of [
      [
        'traffic-surge',
        (s: Record<string, unknown>) => {
          expect(s).toMatchObject({ shedding: true });
          expect(s.eps).toBe(48 * 2 * 5);
        },
      ],
      ['duplicate-storm', (s: Record<string, unknown>) => expect(s.duplicate as number).toBeGreaterThan(0)],
      ['malformed-flood', (s: Record<string, unknown>) => expect(s.rejected as number).toBeGreaterThan(0)],
    ] as const) {
      const h = harness();
      h.be.chaosStart(admin, { scenario, durationSec: 60 });
      h.at(QUIET + 5);
      check(h.be.frame!.stats as unknown as Record<string, unknown>);
      expect(h.be.chaosRuns(admin)[0]!.correct).toBeNull();
    }
  });

  it('runs expire on their own, and stopping all ends every active run', () => {
    const h = harness();
    const updates: ChaosUpd[] = [];
    const socket = new MockSocket(h.be, admin, 't', { latencyMs: 0 });
    socket.on('chaos:upd', ((u: ChaosUpd) => updates.push(u)) as never);
    socket.connect();
    socket.emit('sub', { rooms: ['meta'] }, () => {});
    expect(updates.at(-1)).toEqual({ active: [] }); // snapshot on join

    h.be.chaosStart(admin, { scenario: 'duplicate-storm', durationSec: 10 });
    h.be.chaosStart(admin, { scenario: 'cache-outage', durationSec: 600 });
    expect(updates.at(-1)!.active).toHaveLength(2);
    h.at(QUIET + 12);
    expect(updates.at(-1)!.active.map((a) => a.scenario)).toEqual(['cache-outage']);
    h.be.chaosStop(admin);
    expect(updates.at(-1)).toEqual({ active: [] });
  });

  it('never rewrites history: points already served stay the same after a run starts or stops', () => {
    const h = harness();
    const n = h.be.world.nodes.find((x) => x.serviceId === 'db')!;
    const before = h.be.nodeSeries(admin, n.nodeId, (QUIET - 60) * 1000, QUIET * 1000);
    const run = h.be.chaosStart(admin, { scenario: 'slow-db', target: 'db', durationSec: 100 });
    h.at(QUIET + 20);
    h.be.chaosStop(admin, run.runId);
    h.at(QUIET + 30);
    expect(h.be.nodeSeries(admin, n.nodeId, (QUIET - 60) * 1000, QUIET * 1000)).toEqual(before);
    const during = h.be.nodeSeries(admin, n.nodeId, (QUIET + 15) * 1000, (QUIET + 18) * 1000);
    expect(Math.min(...during.lat)).toBeGreaterThan(Math.max(...before.lat) * 5);
  });

  it('pauses the scheduled background fault while a run is active', () => {
    const slowDb = 5 * 1_000_000 * FAULT_CYCLE + FAULT_START;
    const h = harness(slowDb - 20);
    h.be.chaosStart(admin, { scenario: 'duplicate-storm', durationSec: 60 });
    expect(h.be.world.faultsAt(slowDb + 10).map((f) => f.kind)).toEqual(['duplicate-storm']);
    expect(h.be.world.scheduledAt(slowDb + 10)?.kind).toBe('slow-db');
  });

  it('only admins may run chaos, with validated input', () => {
    const h = harness();
    expect(() => h.be.chaosStart(sre, { scenario: 'slow-db' })).toThrow(/admin/);
    expect(() => h.be.chaosScenarios(sre)).toThrow(/admin/);
    expect(() => h.be.chaosStart(admin, { scenario: 'nope' as never })).toThrow(/Unknown scenario/);
    expect(() => h.be.chaosStart(admin, { scenario: 'cpu-spike' })).toThrow(/node/);
    expect(() => h.be.chaosStart(admin, { scenario: 'slow-db', target: 'mainframe' })).toThrow(/service/);
    expect(() => h.be.chaosStart(admin, { scenario: 'slow-db', durationSec: 2 })).toThrow(/Duration/);
    expect(h.be.chaosStart(admin, { scenario: 'slow-db' }).target).toBe('db'); // the scenario's default target
    expect(h.be.chaosScenarios(admin).scenarios).toBe(CHAOS_SCENARIOS);
  });
});
