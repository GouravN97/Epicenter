import { describe, expect, it } from 'vitest';
import { INCIDENT_JOIN_WINDOW_MS, INCIDENT_RESOLVE_QUIET_MS, type AlertDTO, type ServiceId, type Severity } from '@epicenter/shared';
import { Correlator, analyse, incidentTeams, pickChaosRun, type ChaosCandidate, type Incident } from './correlator';

const T0 = 1_700_000_000_000;
let n = 0;
const alert = (serviceId: ServiceId, at: number, severity: Severity = 'warn', metric = 'lat'): AlertDTO => ({
  id: `a${++n}`,
  key: `${serviceId}.01|${metric}|zscore`,
  nodeId: `us-east-1a.${serviceId}.01`,
  serviceId,
  team: 'x',
  metric,
  rule: 'zscore',
  severity,
  state: 'firing',
  value: 1,
  threshold: 1,
  message: 'm',
  startedAt: at,
  ackedBy: null,
  resolvedAt: null,
  incidentId: null,
});

function harness(runs: ChaosCandidate[] = []) {
  let id = 0;
  const c = new Correlator(() => `inc${++id}`, () => runs);
  const opened: Incident[] = [];
  const updates: Incident[] = [];
  const cards: unknown[] = [];
  c.on({ open: (i) => opened.push(i), update: (i) => updates.push(i), scorecard: (s) => cards.push({ ...s }) });
  return { c, opened, updates, cards };
}

/** Fires alerts at the given service, `gap` ms apart, in order. */
function fire(c: Correlator, services: ServiceId[], gap = 1000, start = T0) {
  return services.map((s, i) => {
    const a = alert(s, start + i * gap);
    c.onAlertFired(a, start + i * gap);
    return a;
  });
}

describe('analyse (epicenter on the topology)', () => {
  const at = (s: ServiceId, t: number, severity: Severity = 'warn') => ({ serviceId: s, startedAt: t, severity });

  it('db fault → epicenter db, even when a caller alerted first', () => {
    const r = analyse([at('orders-api', 1), at('worker', 2), at('db', 3), at('catalog-api', 4), at('edge-gateway', 5), at('auth', 6)])!;
    expect(r.epicenter).toBe('db');
    expect(new Set(r.blastRadius)).toEqual(new Set(['auth', 'catalog-api', 'orders-api', 'worker', 'edge-gateway']));
    expect(r.confidence).toBe(1);
  });

  it('cache fault → epicenter cache; blast radius auth, catalog, gateway', () => {
    const r = analyse([at('auth', 1), at('catalog-api', 2), at('cache', 3), at('edge-gateway', 4)])!;
    expect(r.epicenter).toBe('cache');
    expect(new Set(r.blastRadius)).toEqual(new Set(['auth', 'catalog-api', 'edge-gateway']));
    expect(r.confidence).toBe(1);
  });

  it('gateway fault → epicenter gateway, empty blast radius', () => {
    const r = analyse([at('edge-gateway', 1)])!;
    expect(r).toEqual({ epicenter: 'edge-gateway', blastRadius: [], confidence: 1 });
  });

  it('two independent roots: earliest onset wins and confidence reflects what is unexplained', () => {
    const r = analyse([at('payments', 5), at('cache', 1), at('auth', 2)])!;
    expect(r.epicenter).toBe('cache');
    expect(r.confidence).toBeCloseTo(2 / 3, 2); // payments is not in cache's blast radius
  });

  it('ties on onset break by severity', () => {
    expect(analyse([at('payments', 1, 'warn'), at('queue', 1, 'crit')])!.epicenter).toBe('queue');
  });

  it('nothing firing → null', () => {
    expect(analyse([])).toBeNull();
  });
});

describe('Correlator', () => {
  it('slow-db cascade becomes ONE incident with epicenter db', () => {
    const h = harness();
    // worker is not adjacent to orders-api, so it opens its own incident first; db connects the two.
    fire(h.c, ['orders-api', 'worker', 'db', 'catalog-api', 'edge-gateway']);
    expect(h.c.openIncidents()).toHaveLength(1);
    expect(h.opened).toHaveLength(2);
    expect(h.updates.find((i) => i.id === 'inc2')).toMatchObject({ state: 'resolved', mergedInto: 'inc1' });
    const inc = h.c.openIncidents()[0]!;
    expect(inc.id).toBe('inc1');
    expect(inc.alerts.size).toBe(5);
    expect(inc.epicenter).toBe('db');
    expect(inc.confidence).toBe(1);
    expect(inc.affected).toHaveLength(5);
    expect(inc.title).toBe('db: zscore/lat — 5 services affected');
    expect(inc.timeline.filter((e) => e.kind === 'epicenter').map((e) => e.text)).toEqual([
      'Epicenter: orders-api',
      'Epicenter: worker', // from the merged incident's own timeline
      'Epicenter: db',
    ]);
    expect(incidentTeams(inc).sort()).toEqual(['commerce', 'data', 'platform']);
  });

  it('sets incidentId on the alerts it attaches', () => {
    const h = harness();
    const [a] = fire(h.c, ['db']);
    expect(a!.incidentId).toBe('inc1');
  });

  it('an unrelated service opens a separate incident', () => {
    const h = harness();
    fire(h.c, ['cache']);
    fire(h.c, ['payments'], 1000, T0 + 2000); // payments is not adjacent to cache
    expect(h.opened).toHaveLength(2);
  });

  it('a neighbour joins only within the 60 s join window', () => {
    const h = harness();
    fire(h.c, ['db']);
    fire(h.c, ['orders-api'], 1000, T0 + INCIDENT_JOIN_WINDOW_MS + 1);
    expect(h.opened).toHaveLength(2);
  });

  it('resolves after 30 s with no firing alert, keeping the epicenter', () => {
    const h = harness();
    const [a, b] = fire(h.c, ['db', 'orders-api']);
    h.c.onAlertResolved({ ...a!, state: 'resolved' }, T0 + 10_000);
    h.c.tick(T0 + 50_000);
    expect(h.c.openIncidents()).toHaveLength(1); // orders-api still firing
    h.c.onAlertResolved({ ...b!, state: 'resolved' }, T0 + 20_000);
    h.c.tick(T0 + 20_000 + INCIDENT_RESOLVE_QUIET_MS - 1);
    expect(h.c.openIncidents()).toHaveLength(1);
    h.c.tick(T0 + 20_000 + INCIDENT_RESOLVE_QUIET_MS);
    expect(h.c.openIncidents()).toHaveLength(0);
    const last = h.updates.at(-1)!;
    expect(last).toMatchObject({ state: 'resolved', epicenter: 'db', endedAt: T0 + 20_000 + INCIDENT_RESOLVE_QUIET_MS });
  });

  it('a new alert during the quiet period keeps the incident open', () => {
    const h = harness();
    const [a] = fire(h.c, ['db']);
    h.c.onAlertResolved({ ...a!, state: 'resolved' }, T0 + 1000);
    fire(h.c, ['worker'], 1000, T0 + 20_000);
    h.c.tick(T0 + 1000 + INCIDENT_RESOLVE_QUIET_MS + 5000);
    expect(h.c.openIncidents()).toHaveLength(1);
    expect(h.opened).toHaveLength(1);
  });
});

describe('chaos scorecard', () => {
  const run = (scenario: ChaosCandidate['scenario'], service: ServiceId | null, startedAt: number): ChaosCandidate => ({
    runId: `${scenario}@${startedAt}`, scenario, service, startedAt,
  });

  it('pickChaosRun: latest run started within 120 s before the incident', () => {
    const runs = [run('slow-db', 'db', T0 - 200_000), run('cache-outage', 'cache', T0 - 30_000), run('slow-db', 'db', T0 - 10_000), run('slow-db', 'db', T0 + 1)];
    expect(pickChaosRun(T0, runs)!.startedAt).toBe(T0 - 10_000);
    expect(pickChaosRun(T0, [runs[0]!])).toBeNull();
  });

  it('slow-db run → linked, detectedEpicenter db, correct; scorecard follows epicenter changes', () => {
    const h = harness([run('slow-db', 'db', T0 - 8_000)]);
    fire(h.c, ['orders-api', 'db']);
    const inc = h.c.openIncidents()[0]!;
    expect(inc.chaos).toMatchObject({ scenario: 'slow-db', service: 'db', detectedAt: T0, detectedEpicenter: 'db', correct: true });
    expect(h.cards).toEqual([
      expect.objectContaining({ detectedEpicenter: 'orders-api', correct: false }),
      expect.objectContaining({ detectedEpicenter: 'db', correct: true }),
    ]);
  });

  it('a wrong epicenter is reported as a miss; a run is linked to one incident only', () => {
    const h = harness([run('cache-outage', 'cache', T0 - 5_000)]);
    fire(h.c, ['payments']);
    expect(h.c.openIncidents()[0]!.chaos).toMatchObject({ detectedEpicenter: 'payments', correct: false });
    fire(h.c, ['queue'], 1000, T0 + 61_000);
    expect(h.c.openIncidents().find((i) => i.affected.includes('queue'))!.chaos).toBeNull();
  });

  it('scenarios without a target service score null', () => {
    const h = harness([run('traffic-surge', null, T0 - 5_000)]);
    fire(h.c, ['edge-gateway']);
    expect(h.c.openIncidents()[0]!.chaos).toMatchObject({ correct: null, detectedEpicenter: 'edge-gateway' });
  });
});
