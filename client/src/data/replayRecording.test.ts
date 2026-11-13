import { describe, expect, it } from 'vitest';
import { NodeStatus, REPLAY_MAX_RANGE_MS, type UserDTO } from '@epicenter/shared';
import { MockBackend, MOCK_LAG_SEC } from '../mocks/mockBackend';
import { FAULT_CYCLE, FAULT_START } from '../mocks/mockWorld';
import { FleetState } from './fleetState';
import { ReplayRecording, incidentMetric, replayWindow } from './replayRecording';

const admin: UserDTO = { id: 'a', email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: ['platform', 'commerce', 'payments', 'data'] };
const viewer: UserDTO = { id: 'v', email: 'payments@epicenter.dev', name: 'Viewer', role: 'viewer', teams: ['payments'] };
const CYCLE0 = 5 * 1_000_000 * FAULT_CYCLE;
const SLOW_DB = CYCLE0 + FAULT_START;
const NODE_KILL = CYCLE0 + 3 * FAULT_CYCLE + FAULT_START;

function backendAt(sec: number) {
  return new MockBackend({ now: () => (sec + MOCK_LAG_SEC) * 1000 });
}

function record(be: MockBackend, user: UserDTO) {
  be.advance();
  const inc = be.incidentList(user).find((i) => i.epicenter)!;
  const detail = be.incidentDetail(user, inc.id);
  const w = replayWindow(inc, be.cursor * 1000, REPLAY_MAX_RANGE_MS);
  const services = [inc.epicenter!, ...inc.blastRadius];
  const res = be.replay(user, w.from, w.to, services);
  const idx = new Map(be.world.nodes.map((n) => [n.nodeId, n.idx]));
  return { inc, detail, w, rec: new ReplayRecording(res, detail.alerts, (id) => idx.get(id)) };
}

describe('replay recording', () => {
  it('reconstructs a slow-db incident: quiet before, cascade during, epicenter latency in the series', () => {
    const be = backendAt(SLOW_DB + 60);
    const { inc, detail, w, rec } = record(be, admin);
    expect(inc.epicenter).toBe('db');
    expect(w.from).toBe(Math.floor((inc.startedAt - 60_000) / 1000) * 1000);
    expect(rec.services.size).toBe(6); // db plus its five dependents

    const db = be.world.nodes.find((n) => n.serviceId === 'db')!;
    const before = rec.snapshotAt(inc.startedAt - 30_000);
    const during = rec.snapshotAt(inc.startedAt + 20_000);
    expect(before.services[db.svcIdx]!.status).toBe(NodeStatus.ok);
    expect(during.services[db.svcIdx]!.status).toBeGreaterThan(NodeStatus.ok);
    expect(during.services[db.svcIdx]!.lat).toBeGreaterThan(before.services[db.svcIdx]!.lat * 3);
    expect(before.services[db.svcIdx]!.healthy).toBe(4);

    const fleet = new FleetState();
    rec.frameAt(inc.startedAt + 20_000, fleet, be.world.nodes.length);
    expect(fleet.status[db.idx]).toBeGreaterThan(NodeStatus.ok);
    const payments = be.world.nodes.find((n) => n.serviceId === 'payments')!;
    expect(fleet.seen[payments.idx]).toBe(0); // not part of the recording

    const series = rec.serviceSeries(db.svcIdx, incidentMetric(detail.alerts));
    expect(incidentMetric(detail.alerts)).toBe('lat');
    expect(series.t.length).toBe((w.to - w.from) / 1000 + (w.from % 1000 === 0 ? 1 : 0));
    expect(Math.max(...series.v.map((x) => x ?? 0))).toBeGreaterThan(100);
  });

  it('shows a killed node as silent while it was down and reporting again after', () => {
    const be = backendAt(NODE_KILL + 100);
    const { inc, rec } = record(be, admin);
    const target = be.world.faultAt(NODE_KILL + 1)!.nodeIdx!;
    const fleet = new FleetState();
    rec.frameAt(inc.startedAt + 5_000, fleet, be.world.nodes.length);
    expect(fleet.status[target]).toBe(NodeStatus.silent);
    rec.frameAt(inc.startedAt - 20_000, fleet, be.world.nodes.length);
    expect(fleet.status[target]).toBe(NodeStatus.ok);
  });

  it('only records what the user may see', () => {
    const be = backendAt(SLOW_DB + 60);
    be.advance();
    const inc = be.incidentList(admin)[0]!;
    const res = be.replay(viewer, inc.startedAt - 60_000, inc.startedAt + 60_000, ['db', 'payments']);
    expect(res.nodes.every((n) => n.nodeId.includes('.payments.'))).toBe(true);
    expect(() => be.replay(admin, 0, REPLAY_MAX_RANGE_MS + 1000, ['db'])).toThrow(/10 minutes/);
  });

  it('links the fault that caused an incident as its scorecard', () => {
    const be = backendAt(SLOW_DB + 60);
    const { detail } = record(be, admin);
    expect(detail.chaos).toMatchObject({ scenario: 'slow-db', target: 'db', detectedEpicenter: 'db', correct: true });
    expect(detail.chaos!.timeToDetectMs).toBeGreaterThan(0);
    expect(detail.chaos!.timeToDetectMs).toBeLessThan(30_000);
  });

  it('clamps the window to the 10-minute limit and to now', () => {
    expect(replayWindow({ startedAt: 100_000, endedAt: null }, 130_000, REPLAY_MAX_RANGE_MS)).toEqual({ from: 40_000, to: 130_000 });
    expect(replayWindow({ startedAt: 100_000, endedAt: 2_000_000 }, 3_000_000, REPLAY_MAX_RANGE_MS)).toEqual({ from: 40_000, to: 640_000 });
    expect(replayWindow({ startedAt: 100_000, endedAt: 200_000 }, 3_000_000, REPLAY_MAX_RANGE_MS)).toEqual({ from: 40_000, to: 230_000 });
  });
});
