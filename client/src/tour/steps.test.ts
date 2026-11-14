import { describe, expect, it } from 'vitest';
import type { AlertDTO, IncidentDTO } from '@epicenter/shared';
import { TOUR_STEPS, isAt, lastRun, routeOf, stepsFor, tourIncident, type TourCtx } from './steps';

const ctx = (over: Partial<TourCtx> = {}): TourCtx => ({
  pathname: '/',
  role: 'admin',
  mock: true,
  firstNodeId: 'us-east-1a.db.01',
  alerts: [],
  incidents: [],
  chaosActive: [],
  chaosHistory: [],
  replaying: false,
  comparing: false,
  ...over,
});
const step = (id: string) => TOUR_STEPS.find((s) => s.id === id)!;
const alert = (over: Partial<AlertDTO>): AlertDTO => ({ id: 'a1', nodeId: 'n1', rule: 'zscore', state: 'firing', startedAt: 10_000, ...over }) as AlertDTO;
const incident = (over: Partial<IncidentDTO>): IncidentDTO => ({ id: 'i1', state: 'open', epicenter: 'db', affected: ['db'], startedAt: 10_000, ...over }) as IncidentDTO;

describe('tour steps', () => {
  it('has unique ids', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives only admins the Chaos Lab steps, and everyone a start and an end', () => {
    for (const role of ['admin', 'sre', 'viewer'] as const) {
      const steps = stepsFor(role);
      expect(steps[0]!.id).toBe('welcome');
      expect(steps.at(-1)!.id).toBe('done');
      const chaos = steps.filter((s) => s.route?.(ctx({ role })) === '/chaos');
      expect(chaos.length > 0).toBe(role === 'admin');
    }
    expect(stepsFor('viewer').some((s) => s.id === 'alert-wait')).toBe(true);
    expect(stepsFor('admin').some((s) => s.id === 'alert-wait')).toBe(false);
  });

  it('knows where a step happens', () => {
    expect(isAt(step('welcome'), ctx({ pathname: '/pipeline' }))).toBe(true);
    expect(isAt(step('tiles'), ctx({ pathname: '/' }))).toBe(true);
    expect(isAt(step('tiles'), ctx({ pathname: '/topology' }))).toBe(false);
    expect(isAt(step('node-charts'), ctx({ pathname: '/node/anything' }))).toBe(true);
    expect(routeOf(step('node-charts'), ctx())).toBe('/node/us-east-1a.db.01');
    expect(routeOf(step('node-charts'), ctx({ firstNodeId: null }))).toBeNull();
  });

  it('completes "open a node" when a node page is open', () => {
    const task = step('fleet').task!;
    expect(task.done(ctx())).toBe(false);
    expect(task.done(ctx({ pathname: '/node/n1' }))).toBe(true);
  });

  it('completes a start exercise while that scenario is running', () => {
    const task = step('slowdb-start').task!;
    expect(task.done(ctx())).toBe(false);
    expect(task.done(ctx({ chaosActive: [{ runId: 'r', scenario: 'cpu-spike', target: 'n1', endsAt: 1 }] }))).toBe(false);
    expect(task.done(ctx({ chaosActive: [{ runId: 'r', scenario: 'slow-db', target: 'db', endsAt: 1 }] }))).toBe(true);
  });

  it('warns when another fault is running', () => {
    const caution = step('slowdb-start').caution!;
    expect(caution(ctx())).toBeNull();
    expect(caution(ctx({ chaosActive: [{ runId: 'r', scenario: 'node-kill', target: 'n1', endsAt: 1 }] }))).toMatch(/still running/);
  });

  it('sends the CPU exercise to the spiked node and waits for an alert on it from that run', () => {
    const watch = step('cpu-watch');
    const run = { scenario: 'cpu-spike' as const, target: 'n1', startedAt: 10_000 };
    expect(routeOf(watch, ctx())).toBeNull();
    expect(routeOf(watch, ctx({ chaosHistory: [run] }))).toBe('/node/n1');
    expect(watch.task!.done(ctx({ chaosHistory: [run], alerts: [alert({ nodeId: 'other' })] }))).toBe(false);
    expect(watch.task!.done(ctx({ chaosHistory: [run], alerts: [alert({ startedAt: 1000 })] }))).toBe(false);
    expect(watch.task!.done(ctx({ chaosHistory: [run], alerts: [alert({ startedAt: 14_000 })] }))).toBe(true);
  });

  it('needs a heartbeat alert for the killed node', () => {
    const task = step('kill-watch').task!;
    const run = { scenario: 'node-kill' as const, target: 'n1', startedAt: 10_000 };
    expect(task.done(ctx({ chaosHistory: [run], alerts: [alert({ rule: 'zscore' })] }))).toBe(false);
    expect(task.done(ctx({ chaosHistory: [run], alerts: [alert({ rule: 'heartbeat', startedAt: 16_000 })] }))).toBe(true);
  });

  it('prefers the newest run of a scenario and falls back to the active list', () => {
    expect(lastRun(ctx(), 'slow-db')).toBeNull();
    expect(lastRun(ctx({ chaosActive: [{ runId: 'r', scenario: 'slow-db', target: 'db', endsAt: 1 }] }), 'slow-db')).toEqual({ target: 'db', startedAt: 0 });
    const history = [
      { scenario: 'slow-db' as const, target: 'db', startedAt: 50_000 },
      { scenario: 'slow-db' as const, target: 'db', startedAt: 10_000 },
    ];
    expect(lastRun(ctx({ chaosHistory: history }), 'slow-db')!.startedAt).toBe(50_000);
  });

  it('waits for an incident caused by the slow-database run, or any open one without a run', () => {
    const task = step('incident').task!;
    const run = { scenario: 'slow-db' as const, target: 'db', startedAt: 50_000 };
    const old = incident({ id: 'old', startedAt: 10_000, state: 'resolved' });
    const fresh = incident({ id: 'new', startedAt: 60_000 });
    expect(task.done(ctx({ chaosHistory: [run], incidents: [old] }))).toBe(false);
    expect(task.done(ctx({ chaosHistory: [run], incidents: [fresh, old] }))).toBe(true);
    expect(task.done(ctx({ incidents: [old] }))).toBe(false);
    expect(task.done(ctx({ incidents: [incident({ epicenter: null })] }))).toBe(false);
    expect(task.done(ctx({ incidents: [incident({})] }))).toBe(true);
    expect(tourIncident(ctx({ chaosHistory: [run], incidents: [fresh, old] }))!.id).toBe('new');
    const stray = incident({ id: 'stray', startedAt: 70_000, epicenter: 'edge-gateway', affected: ['edge-gateway'] });
    expect(tourIncident(ctx({ chaosHistory: [run], incidents: [stray, fresh, old] }))!.id).toBe('new');
    expect(routeOf(step('room'), ctx({ incidents: [fresh] }))).toBe('/incidents/new');
    expect(routeOf(step('room'), ctx())).toBe('/incidents');
  });
});
