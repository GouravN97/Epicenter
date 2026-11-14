import { describe, expect, it } from 'vitest';
import {
  alertKinds,
  buildInsights,
  explainEpicenter,
  rankSimilar,
  similarityScore,
  spanText,
  suggestChecks,
  transitiveDependents,
  utcStamp,
  type AlertDTO,
  type ChaosScorecard,
  type IncidentDTO,
  type IncidentDetailDTO,
  type InsightCandidate,
} from './index';

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
let n = 0;

function alert(serviceId: string, at: number, over: Partial<AlertDTO> = {}): AlertDTO {
  const nodeId = over.nodeId ?? `use1a-${serviceId}-1`;
  const metric = over.metric ?? 'lat';
  const rule = over.rule ?? 'threshold';
  return {
    id: `a${++n}`,
    key: `${nodeId}|${metric}|${rule}`,
    nodeId,
    serviceId,
    team: 'data',
    metric,
    rule,
    severity: 'warn',
    state: 'firing',
    value: 200,
    threshold: 60,
    message: `${metric} over the limit`,
    startedAt: T0 + at * 1000,
    ...over,
  };
}

function incident(epicenter: string | null, affected: string[], over: Partial<IncidentDTO> = {}): IncidentDTO {
  return {
    id: 'inc-1',
    title: `${epicenter}: threshold/lat — ${affected.length} services affected`,
    state: 'open',
    epicenter,
    confidence: 1,
    affected,
    blastRadius: epicenter ? [...transitiveDependents(epicenter as 'db')] : [],
    startedAt: T0,
    endedAt: null,
    ...over,
  };
}

const detailOf = (inc: IncidentDTO, alerts: AlertDTO[], over: Partial<IncidentDetailDTO> = {}): IncidentDetailDTO => ({
  ...inc,
  alerts,
  timeline: [{ ts: inc.startedAt, kind: 'system', text: 'Incident opened' }],
  chaos: null,
  ...over,
});

// The slow-db cascade: orders-api (a caller) crosses its limit a second before db does.
const cascade = () => [alert('orders-api', 0), alert('db', 1, { severity: 'crit' }), alert('db', 1, { nodeId: 'use1b-db-2' }), alert('auth', 3), alert('edge-gateway', 5)];
const cascadeIncident = () => incident('db', ['orders-api', 'db', 'auth', 'edge-gateway']);

describe('explainEpicenter', () => {
  it('db cascade: db is the epicenter, its callers are downstream, in order of first alert', () => {
    const e = explainEpicenter(cascadeIncident(), cascade());
    expect(e.services.map((s) => [s.serviceId, s.role])).toEqual([
      ['orders-api', 'downstream'],
      ['db', 'epicenter'],
      ['auth', 'downstream'],
      ['edge-gateway', 'downstream'],
    ]);
    const db = e.services.find((s) => s.serviceId === 'db')!;
    expect(db).toMatchObject({ alertCount: 2, severity: 'crit', dominant: 'threshold/lat', firstAlertAt: T0 + 1000 });
  });

  it('says why: no dependencies, a caller alerted first, all alerting services explained', () => {
    const { reasons } = explainEpicenter(cascadeIncident(), cascade());
    expect(reasons[0]).toBe('Database depends on no other service, so nothing upstream of it can be the cause.');
    expect(reasons[1]).toMatch(/^Orders API alerted before Database but calls it/);
    expect(reasons[2]).toBe('4 of 4 alerting services are Database or depend on it.');
    expect(reasons).toHaveLength(3);
  });

  it('names healthy dependencies when the epicenter has some, and the onset when it alerted first', () => {
    const { reasons } = explainEpicenter(incident('auth', ['auth', 'edge-gateway']), [alert('auth', 0), alert('edge-gateway', 4)]);
    expect(reasons[0]).toBe("None of Auth's dependencies (Cache, Database) is alerting, so the fault starts here and not upstream.");
    expect(reasons[1]).toBe('Auth alerted first; 1 other service followed within 4 s.');
  });

  it('flags a service the epicenter does not explain', () => {
    const e = explainEpicenter(incident('cache', ['cache', 'auth', 'payments'], { confidence: 0.67 }), [alert('cache', 0), alert('auth', 2), alert('payments', 3)]);
    expect(e.services.find((s) => s.serviceId === 'payments')!.role).toBe('unexplained');
    expect(e.reasons).toContain('2 of 3 alerting services are Cache or depend on it.');
    expect(e.reasons.at(-1)).toBe('Not explained by Cache: Payments. That may be a separate fault.');
  });

  it('a single service, and an incident with no epicenter yet', () => {
    expect(explainEpicenter(incident('payments', ['payments']), [alert('payments', 0)]).reasons.at(-1)).toBe('Payments is the only service alerting.');
    const none = explainEpicenter(incident(null, ['payments']), []);
    expect(none.reasons).toEqual(['The epicenter has not been identified yet: alerts are still being correlated.']);
    expect(none.services).toHaveLength(1); // affected services are listed even without their alerts
  });
});

describe('suggestChecks', () => {
  const checksFor = (inc: IncidentDTO, alerts: AlertDTO[], chaos: ChaosScorecard | null = null) =>
    suggestChecks(inc, alerts, chaos, explainEpicenter(inc, alerts));

  it('slow database: a database latency check on the worst node, then scope, then callers', () => {
    const c = checksFor(cascadeIncident(), cascade());
    expect(c.map((x) => x.id)).toEqual(['symptom:lat', 'scope', 'downstream']);
    expect(c[0]).toMatchObject({ title: 'Database is slow', target: { kind: 'node', id: 'use1a-db-1' } }); // the crit one
    expect(c[0]!.detail).toMatch(/slow queries/);
    expect(c[1]!.title).toBe('2 of 4 Database nodes are affected');
    expect(c[2]!.detail).toMatch(/^Orders API, Auth, Edge Gateway are alerting because they call Database/);
  });

  it('the advice depends on the kind of service', () => {
    const cache = checksFor(incident('cache', ['cache']), [alert('cache', 0, { metric: 'err' })]);
    expect(cache[0]!.detail).toMatch(/fall back to the database/);
    const api = checksFor(incident('auth', ['auth']), [alert('auth', 0)]);
    expect(api[0]!.detail).toMatch(/recent deploy/);
  });

  it('one node of several: a node problem, with heartbeat and predictive rules named by node', () => {
    const dead = checksFor(incident('worker', ['worker']), [alert('worker', 0, { rule: 'heartbeat', metric: 'heartbeat', severity: 'crit', nodeId: 'use1a-worker-3' })]);
    expect(dead.map((x) => x.id)).toEqual(['symptom:heartbeat', 'scope']);
    expect(dead[0]!.title).toBe('use1a-worker-3 stopped reporting');
    expect(dead[1]).toMatchObject({ title: 'Only 1 of 10 Worker nodes is affected', target: { kind: 'node', id: 'use1a-worker-3' } });
    const leak = checksFor(incident('worker', ['worker']), [alert('worker', 0, { rule: 'predictive', metric: 'mem' })]);
    expect(leak[0]!.title).toMatch(/^Memory is climbing steadily on/);
  });

  it('puts a linked chaos run first, and asks to stop it only while the incident is open', () => {
    const chaos: ChaosScorecard = { runId: 'r1', scenario: 'slow-db', target: 'db', startedAt: T0 - 9000, detectedAt: T0, timeToDetectMs: 9000, detectedEpicenter: 'db', correct: true };
    const open = checksFor(cascadeIncident(), cascade(), chaos);
    expect(open[0]).toMatchObject({ id: 'chaos', detail: '“Slow database” on db started 9 s before this incident was detected. Stop it in the Chaos Lab and confirm the fleet recovers.' });
    const closed = checksFor({ ...cascadeIncident(), state: 'resolved', endedAt: T0 + 60_000 }, cascade(), chaos);
    expect(closed[0]!.detail).not.toMatch(/Stop it/);
  });

  it('an unexplained service gets its own check; no epicenter gives no service checks', () => {
    const inc = incident('cache', ['cache', 'payments']);
    const c = checksFor(inc, [alert('cache', 0), alert('payments', 1)]);
    expect(c.at(-1)).toMatchObject({ id: 'separate', title: 'Investigate Payments separately', target: { kind: 'service', id: 'payments' } });
    expect(checksFor(incident(null, ['payments']), [alert('payments', 0)])).toEqual([]);
  });
});

describe('similar incidents', () => {
  const kinds = ['threshold/lat', 'zscore/lat'];
  const current = { id: 'inc-1', epicenter: 'db', affected: ['db', 'auth', 'orders-api', 'edge-gateway'], kinds };
  const past = (id: string, epicenter: string | null, affected: string[], k: string[], startedAt = T0 - 3_600_000): InsightCandidate => ({
    incident: { ...incident(epicenter, affected), id, state: 'resolved', startedAt, endedAt: startedAt + 90_000 },
    kinds: k,
    notes: [{ text: 'Restarted the primary', userName: 'Sam' }],
  });

  it('scores 1 for an identical incident and explains the match', () => {
    expect(similarityScore(current, current)).toEqual({ score: 1, reasons: ['Same epicenter (Database)', '4 of 4 affected services in common', 'Same kinds of alert'] });
  });

  it('weights epicenter 0.5, affected overlap 0.3 and alert kinds 0.2', () => {
    // Same epicenter, 2 of 4 services, 1 of 2 kinds → 0.5 + 0.15 + 0.1
    expect(similarityScore(current, { epicenter: 'db', affected: ['db', 'auth'], kinds: ['threshold/lat'] }).score).toBe(0.75);
    // Different epicenter, nothing shared
    expect(similarityScore(current, { epicenter: 'cache', affected: ['cache'], kinds: ['threshold/err'] })).toEqual({ score: 0, reasons: [] });
    // Two incidents without an epicenter do not count as "the same epicenter"
    expect(similarityScore({ epicenter: null, affected: [], kinds: [] }, { epicenter: null, affected: [], kinds: [] }).score).toBe(0);
  });

  it('ranks by score, newer first on ties, drops weak matches and itself, keeps at most three', () => {
    const out = rankSimilar(current, [
      past('weak', 'cache', ['cache', 'auth'], ['threshold/err']), // 0.3 × 1/5 → below the cut-off
      past('older', 'db', current.affected, kinds, T0 - 7_200_000),
      past('newer', 'db', current.affected, kinds, T0 - 3_600_000),
      past('partial', 'db', ['db', 'auth'], ['threshold/lat']),
      past('fourth', 'db', ['db'], ['threshold/lat']),
      past('inc-1', 'db', current.affected, kinds),
    ]);
    expect(out.map((s) => s.incident.id)).toEqual(['newer', 'older', 'partial']);
    expect(out[0]).toMatchObject({ score: 1, durationMs: 90_000, notes: [{ text: 'Restarted the primary', userName: 'Sam' }] });
  });

  it('alertKinds: unique rule/metric pairs, sorted', () => {
    expect(alertKinds(cascade().concat(alert('db', 2, { rule: 'zscore' })))).toEqual(['threshold/lat', 'zscore/lat']);
  });
});

describe('postmortem draft', () => {
  const chaos: ChaosScorecard = { runId: 'r1', scenario: 'slow-db', target: 'db', startedAt: T0 - 9000, detectedAt: T0, timeToDetectMs: 9000, detectedEpicenter: 'db', correct: true };
  const timeline: IncidentDetailDTO['timeline'] = [
    { ts: T0, kind: 'system', text: 'Incident opened' },
    { ts: T0, kind: 'alert', text: 'warn threshold on use1a-orders-api-1: lat over the limit' },
    { ts: T0 + 1000, kind: 'alert', text: 'crit threshold on use1a-db-1: lat over the limit' },
    { ts: T0 + 1000, kind: 'alert', text: 'warn threshold on use1b-db-2: lat over the limit' },
    { ts: T0 + 20_000, kind: 'note', text: 'Failing over to the replica', user: { id: 'u1', name: 'Sam' } },
  ];

  it('resolved incident: every section, UTC times, one timeline line per service', () => {
    const d = detailOf({ ...cascadeIncident(), state: 'resolved', endedAt: T0 + 192_000 }, cascade(), { timeline, chaos });
    const md = buildInsights(d, [], T0 + 600_000).postmortem;
    for (const h of ['# Incident report:', '## Summary', '## Impact', '## Root cause', '## Detection', '## Timeline (UTC)', '## Responder notes', '## Follow-ups']) {
      expect(md).toContain(h);
    }
    expect(md).toContain('- **Ended:** 2026-11-15 12:03:12 UTC (lasted 3 min 12 s)');
    expect(md).toContain('- **Epicenter:** Database (100% confidence)');
    expect(md).toContain('- **Time to detect:** 9 s after the fault was injected');
    expect(md).toContain('The epicenter matches the injected fault.');
    expect(md).toContain('- 12:00:20 Sam: Failing over to the replica');
    expect(md.match(/on use1[ab]-db-/g)).toHaveLength(1); // two db nodes alerted; the timeline keeps the first
    expect(md).toContain('- **First alert:** 2026-11-15 12:00:00 UTC, warn threshold/lat on use1a-orders-api-1');
    expect(md).not.toContain('## Similar past incidents');
    expect(md).toContain('- [ ] Database is slow.');
  });

  it('open incident: says how long it has been open, and lists similar incidents when there are some', () => {
    const d = detailOf(cascadeIncident(), cascade());
    const similar: InsightCandidate = {
      incident: { ...cascadeIncident(), id: 'old', title: 'db: threshold/lat — 4 services affected', state: 'resolved', startedAt: T0 - 86_400_000, endedAt: T0 - 86_400_000 + 120_000 },
      kinds: ['threshold/lat'],
      notes: [],
    };
    const out = buildInsights(d, [similar], T0 + 75_000);
    expect(out.similar).toHaveLength(1);
    expect(out.postmortem).toContain('- **Open for:** 1 min 15 s at the time of this draft');
    expect(out.postmortem).toContain('## Similar past incidents');
    expect(out.postmortem).toContain('(2026-11-14 12:00:00 UTC, lasted 2 min 0 s)');
    expect(out).toMatchObject({ incidentId: 'inc-1', generatedAt: T0 + 75_000 });
  });

  it('formats spans and stamps', () => {
    expect([spanText(900), spanText(59_400), spanText(3_725_000)]).toEqual(['1 s', '59 s', '1 h 2 min']);
    expect(utcStamp(T0)).toBe('2026-11-15 12:00:00 UTC');
  });
});
