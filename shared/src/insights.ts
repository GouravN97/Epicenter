// Incident insights: the questions an on-call engineer asks after "what is broken" — why this service,
// what to check next, have we seen it before, what to write afterwards. Rule-based and deterministic: pure
// functions over an incident, its alerts and the service graph. No model, no I/O. The server feeds them from
// MongoDB (GET /incidents/:id/insights) and the client's mock backend from memory, so both give one answer.
import { INSIGHTS_SIMILAR_MAX, INSIGHTS_SIMILAR_MIN_SCORE, type Severity } from './constants';
import {
  CHAOS_SCENARIOS,
  type AlertDTO,
  type ChaosScorecard,
  type IncidentDTO,
  type IncidentDetailDTO,
  type IncidentInsightsDTO,
  type InsightCheck,
  type InsightService,
  type SimilarIncident,
} from './schemas';
import { SERVICE_BY_ID, directDeps, isServiceId, transitiveDependents, type ServiceId } from './topology';

type Evidence = IncidentInsightsDTO['evidence'];

/** A past incident to compare against, with what the comparison needs. */
export interface InsightCandidate {
  incident: IncidentDTO;
  /** Its alert kinds, as `rule/metric`. */
  kinds: string[];
  notes: { text: string; userName: string }[];
}

const SEV_RANK: Record<Severity, number> = { warn: 1, crit: 2 };
const nameOf = (id: string): string => (isServiceId(id) ? SERVICE_BY_ID[id].name : id);
const list = (ids: readonly string[]): string => ids.map(nameOf).join(', ');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const kindOf = (a: Pick<AlertDTO, 'rule' | 'metric'>): string => `${a.rule}/${a.metric}`;

/** `2026-11-15 12:04:11 UTC`: reports are read in other time zones, so they say which one they use. */
export const utcStamp = (ts: number): string => `${new Date(ts).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const utcTime = (ts: number): string => new Date(ts).toISOString().slice(11, 19);

export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Unique alert kinds (`rule/metric`), sorted. */
export const alertKinds = (alerts: readonly Pick<AlertDTO, 'rule' | 'metric'>[]): string[] => [...new Set(alerts.map(kindOf))].sort();

// ---------------------------------------------------------------------------------------------- evidence

/**
 * Why the correlator named this epicenter (see `analyse` in the server's correlator): it is alerting, none of
 * its dependencies is, and the other alerting services call it.
 */
export function explainEpicenter(incident: IncidentDTO, alerts: readonly AlertDTO[]): Evidence {
  const epi = incident.epicenter;
  const blast = epi && isServiceId(epi) ? transitiveDependents(epi) : new Set<ServiceId>();
  const roleOf = (s: string): InsightService['role'] => (s === epi ? 'epicenter' : blast.has(s as ServiceId) ? 'downstream' : 'unexplained');

  const bySvc = new Map<string, AlertDTO[]>();
  for (const a of alerts) bySvc.set(a.serviceId, [...(bySvc.get(a.serviceId) ?? []), a]);
  // An affected service whose alerts are not in hand still belongs in the picture.
  for (const s of incident.affected) if (!bySvc.has(s)) bySvc.set(s, []);

  const services: InsightService[] = [...bySvc.entries()]
    .map(([serviceId, own]) => {
      const counts = new Map<string, number>();
      for (const a of own) counts.set(kindOf(a), (counts.get(kindOf(a)) ?? 0) + 1);
      return {
        serviceId,
        firstAlertAt: own.length ? Math.min(...own.map((a) => a.startedAt)) : incident.startedAt,
        alertCount: own.length,
        severity: (own.some((a) => a.severity === 'crit') ? 'crit' : 'warn') as Severity,
        dominant: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'anomaly',
        role: roleOf(serviceId),
      };
    })
    .sort((a, b) => a.firstAlertAt - b.firstAlertAt || a.serviceId.localeCompare(b.serviceId));

  const reasons: string[] = [];
  const me = services.find((s) => s.role === 'epicenter');
  if (!epi || !me) {
    reasons.push('The epicenter has not been identified yet: alerts are still being correlated.');
    return { epicenter: epi, confidence: incident.confidence, reasons, services };
  }
  const name = nameOf(epi);
  const others = services.filter((s) => s !== me);

  const deps = isServiceId(epi) ? directDeps(epi) : [];
  if (!deps.length) reasons.push(`${name} depends on no other service, so nothing upstream of it can be the cause.`);
  else reasons.push(`None of ${name}'s dependencies (${list(deps)}) is alerting, so the fault starts here and not upstream.`);

  if (!others.length) {
    reasons.push(`${name} is the only service alerting.`);
  } else {
    const earlier = others.filter((s) => s.firstAlertAt < me.firstAlertAt);
    const last = Math.max(...others.map((s) => s.firstAlertAt));
    if (!earlier.length) {
      reasons.push(`${name} alerted first; ${plural(others.length, 'other service')} followed within ${spanText(last - me.firstAlertAt)}.`);
    } else {
      const callers = earlier.filter((s) => s.role === 'downstream');
      reasons.push(
        callers.length === earlier.length
          ? `${list(earlier.map((s) => s.serviceId))} alerted before ${name} but ${earlier.length === 1 ? 'calls' : 'call'} it: a caller often crosses its limit before the slow dependency does.`
          : `${list(earlier.map((s) => s.serviceId))} alerted before ${name}; onset order alone does not decide the epicenter, the dependency graph does.`,
      );
    }
    const explained = services.filter((s) => s.role !== 'unexplained').length;
    reasons.push(`${explained} of ${plural(services.length, 'alerting service')} ${explained === 1 ? 'is' : 'are'} ${name} or depend on it.`);
    const stray = services.filter((s) => s.role === 'unexplained');
    if (stray.length) reasons.push(`Not explained by ${name}: ${list(stray.map((s) => s.serviceId))}. That may be a separate fault.`);
  }
  return { epicenter: epi, confidence: incident.confidence, reasons, services };
}

// ---------------------------------------------------------------------------------------------- next checks

type ServiceRole = 'database' | 'cache' | 'queue' | 'gateway' | 'api' | 'worker';
const ROLE: Record<ServiceId, ServiceRole> = {
  'edge-gateway': 'gateway',
  auth: 'api',
  'catalog-api': 'api',
  'orders-api': 'api',
  payments: 'api',
  worker: 'worker',
  db: 'database',
  cache: 'cache',
  queue: 'queue',
};

/** What an alert is about, for choosing a check: the rule when it says more than the metric does. */
type Symptom = 'heartbeat' | 'predictive' | 'cpu' | 'mem' | 'lat' | 'err' | 'netIn';
const symptomOf = (a: AlertDTO): Symptom | null =>
  a.rule === 'heartbeat' || a.rule === 'predictive' ? a.rule : (['cpu', 'mem', 'lat', 'err', 'netIn'] as const).find((m) => m === a.metric) ?? null;
const SYMPTOM_ORDER: readonly Symptom[] = ['heartbeat', 'err', 'lat', 'predictive', 'mem', 'cpu', 'netIn'];

const LATENCY: Record<ServiceRole, string> = {
  database: 'Look at slow queries, lock waits and connection-pool saturation.',
  cache: 'Check the hit rate and evictions: a cold or undersized cache is slow and pushes load onto the database.',
  queue: 'Check queue depth and consumer lag: a backlog slows every publisher.',
  gateway: 'Its dependencies are healthy, so look at the gateway itself: connection limits, upstream timeouts, TLS.',
  api: 'Its dependencies are healthy, so look at the service itself: a recent deploy, a thread or connection pool, garbage-collection pauses.',
  worker: 'Check job duration and backlog: one slow job type can hold every worker.',
};
const ERRORS: Record<ServiceRole, string> = {
  database: 'Check for refused connections, a failover in progress or a full disk.',
  cache: 'Check that the cache nodes are reachable. Callers should fall back to the database; watch its load.',
  queue: 'Check the broker and for rejected publishes; messages may be piling up in the callers.',
  gateway: 'Split the errors by route: one failing route points at one backend, all routes point at the gateway.',
  api: 'Read the error log for the dominant error and compare its start with the last deploy.',
  worker: 'Check failed jobs and retries: a poison message can fail every worker that picks it up.',
};
const CPU: Record<ServiceRole, string> = {
  database: 'Look for an expensive query or a missing index.',
  cache: 'Check for a large key scan or an eviction storm.',
  queue: 'Check the publish rate against the consumers.',
  gateway: 'Compare with requests per second: if traffic rose too it is load, so add capacity.',
  api: 'Compare with requests per second: if traffic rose too it is load; if not, look for a hot loop.',
  worker: 'Compare with the queue backlog: a burst of jobs is load; steady input points at a stuck job.',
};

function symptomCheck(sym: Symptom, role: ServiceRole, name: string, node: string): Pick<InsightCheck, 'title' | 'detail'> {
  switch (sym) {
    case 'heartbeat':
      return { title: `${node} stopped reporting`, detail: 'Check that the process and its host are up, then the agent’s connection to the ingest API.' };
    case 'predictive':
      return { title: `Memory is climbing steadily on ${node}`, detail: 'At this slope it reaches the limit within 5 minutes. Look for a leak in the latest deploy; restarting the node buys time.' };
    case 'mem':
      return { title: `Memory is over the limit on ${name}`, detail: 'Check for a leak or an oversized in-memory cache before the process is killed for running out of memory.' };
    case 'cpu':
      return { title: `CPU is saturated on ${name}`, detail: CPU[role] };
    case 'lat':
      return { title: `${name} is slow`, detail: LATENCY[role] };
    case 'err':
      return { title: `${name} is returning errors`, detail: ERRORS[role] };
    case 'netIn':
      return { title: `Inbound traffic to ${name} is unusual`, detail: 'Compare with requests per second at the gateway: a real surge needs capacity, one noisy client needs a rate limit.' };
  }
}

/** What to look at next, most useful first. Rules keyed on the epicenter's kind of service and its alerts. */
export function suggestChecks(incident: IncidentDTO, alerts: readonly AlertDTO[], chaos: ChaosScorecard | null, evidence: Evidence): InsightCheck[] {
  const checks: InsightCheck[] = [];
  const epi = incident.epicenter;

  if (chaos) {
    const scenario = CHAOS_SCENARIOS.find((s) => s.id === chaos.scenario)?.name ?? chaos.scenario;
    const lead = chaos.timeToDetectMs !== null ? ` started ${spanText(chaos.timeToDetectMs)} before this incident was detected` : ' was running when this incident opened';
    checks.push({
      id: 'chaos',
      title: 'A chaos run is the likely cause',
      detail: `“${scenario}”${chaos.target ? ` on ${chaos.target}` : ''}${lead}.${incident.state === 'open' ? ' Stop it in the Chaos Lab and confirm the fleet recovers.' : ''}`,
    });
  }
  if (!epi || !isServiceId(epi)) return checks;

  const name = nameOf(epi);
  const own = alerts.filter((a) => a.serviceId === epi);
  const worst = (xs: readonly AlertDTO[]): AlertDTO =>
    [...xs].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.startedAt - b.startedAt)[0]!;

  for (const sym of SYMPTOM_ORDER) {
    const matching = own.filter((a) => symptomOf(a) === sym);
    if (!matching.length) continue;
    const node = worst(matching).nodeId;
    checks.push({ id: `symptom:${sym}`, ...symptomCheck(sym, ROLE[epi], name, node), target: { kind: 'node', id: node } });
  }

  const nodes = [...new Set(own.map((a) => a.nodeId))];
  const total = SERVICE_BY_ID[epi].nodeCount;
  if (nodes.length === 1 && total > 1) {
    checks.push({
      id: 'scope',
      title: `Only 1 of ${total} ${name} nodes is affected`,
      detail: `The other ${total - 1} are healthy, so this is a node problem and not a service-wide one. Take ${nodes[0]} out of rotation.`,
      target: { kind: 'node', id: nodes[0]! },
    });
  } else if (nodes.length > 1 && nodes.length * 2 >= total) {
    checks.push({
      id: 'scope',
      title: `${nodes.length} of ${total} ${name} nodes are affected`,
      detail: 'Most of the service is affected, so suspect something the nodes share: a deploy, a configuration change or the data behind them.',
      target: { kind: 'service', id: epi },
    });
  }

  const downstream = evidence.services.filter((s) => s.role === 'downstream').map((s) => s.serviceId);
  if (downstream.length) {
    checks.push({
      id: 'downstream',
      title: `Fix ${name} first; its callers should recover on their own`,
      detail: `${list(downstream)} ${downstream.length === 1 ? 'is' : 'are'} alerting because ${downstream.length === 1 ? 'it calls' : 'they call'} ${name}. Restarting ${downstream.length === 1 ? 'it' : 'them'} will not help.`,
      target: { kind: 'service', id: epi },
    });
  }
  const stray = evidence.services.filter((s) => s.role === 'unexplained').map((s) => s.serviceId);
  if (stray.length) {
    checks.push({
      id: 'separate',
      title: `Investigate ${list(stray)} separately`,
      detail: `${stray.length === 1 ? 'It does' : 'They do'} not depend on ${name}, so fixing ${name} will not clear ${stray.length === 1 ? 'its' : 'their'} alerts.`,
      target: { kind: 'service', id: stray[0]! },
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------- similar incidents

function jaccard(a: readonly string[], b: readonly string[]): { score: number; common: number; union: number } {
  const A = new Set(a);
  const B = new Set(b);
  const common = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return { score: union ? common / union : 0, common, union };
}

/**
 * How alike two incidents are, 0..1: 0.5 for the same epicenter, 0.3 × overlap of the affected services,
 * 0.2 × overlap of the alert kinds (overlap = shared / combined).
 */
export function similarityScore(
  a: { epicenter: string | null; affected: readonly string[]; kinds: readonly string[] },
  b: { epicenter: string | null; affected: readonly string[]; kinds: readonly string[] },
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (a.epicenter && a.epicenter === b.epicenter) {
    score += 0.5;
    reasons.push(`Same epicenter (${nameOf(a.epicenter)})`);
  }
  const svc = jaccard(a.affected, b.affected);
  score += 0.3 * svc.score;
  if (svc.common) reasons.push(`${svc.common} of ${plural(svc.union, 'affected service')} in common`);
  const kinds = jaccard(a.kinds, b.kinds);
  score += 0.2 * kinds.score;
  if (kinds.common) reasons.push(kinds.common === kinds.union ? 'Same kinds of alert' : `${kinds.common} of ${plural(kinds.union, 'alert kind')} in common`);
  return { score: Math.round(score * 100) / 100, reasons };
}

/** The closest past incidents: best score first, newer first on a tie. */
export function rankSimilar(
  current: { id: string; epicenter: string | null; affected: readonly string[]; kinds: readonly string[] },
  candidates: readonly InsightCandidate[],
): SimilarIncident[] {
  return candidates
    .filter((c) => c.incident.id !== current.id)
    .map((c) => {
      const { score, reasons } = similarityScore(current, { epicenter: c.incident.epicenter, affected: c.incident.affected, kinds: c.kinds });
      return {
        incident: c.incident,
        score,
        reasons,
        durationMs: c.incident.endedAt !== null ? c.incident.endedAt - c.incident.startedAt : null,
        notes: c.notes,
      };
    })
    .filter((s) => s.score >= INSIGHTS_SIMILAR_MIN_SCORE)
    .sort((x, y) => y.score - x.score || y.incident.startedAt - x.incident.startedAt)
    .slice(0, INSIGHTS_SIMILAR_MAX);
}

// ---------------------------------------------------------------------------------------------- postmortem draft

const TIMELINE_MAX = 40;

/** A Markdown report to start a postmortem from. Everything in it comes from the incident's own data. */
export function buildPostmortem(detail: IncidentDetailDTO, evidence: Evidence, checks: readonly InsightCheck[], similar: readonly SimilarIncident[], now: number): string {
  const open = detail.state === 'open';
  const end = detail.endedAt ?? now;
  const epi = detail.epicenter ? nameOf(detail.epicenter) : 'not identified';
  const downstream = detail.blastRadius.filter((s) => s !== detail.epicenter);
  const first = [...detail.alerts].sort((a, b) => a.startedAt - b.startedAt)[0];
  const notes = detail.timeline.filter((e) => e.kind === 'note');
  const L: string[] = [];

  L.push(`# Incident report: ${detail.title || 'Incident'}`, '');
  L.push('_Drafted by Epicenter from the incident’s own data, using fixed rules (no AI model). Review it before sharing._', '');

  L.push('## Summary', '');
  L.push(`- **Status:** ${open ? 'open' : 'resolved'}`);
  L.push(`- **Started:** ${utcStamp(detail.startedAt)}`);
  L.push(open ? `- **Open for:** ${spanText(end - detail.startedAt)} at the time of this draft` : `- **Ended:** ${utcStamp(end)} (lasted ${spanText(end - detail.startedAt)})`);
  L.push(`- **Epicenter:** ${epi}${detail.epicenter ? ` (${Math.round(detail.confidence * 100)}% confidence)` : ''}`);
  L.push(`- **Alerts:** ${detail.alerts.length} across ${plural(evidence.services.length, 'service')}`, '');

  L.push('## Impact', '');
  L.push(`- **Alerting services:** ${evidence.services.length ? list(evidence.services.map((s) => s.serviceId)) : 'none'}`);
  L.push(`- **Blast radius** (services that depend on the epicenter): ${downstream.length ? list(downstream) : 'none'}`, '');

  L.push('## Root cause', '');
  for (const r of evidence.reasons) L.push(`- ${r}`);
  if (detail.chaos) {
    const c = detail.chaos;
    const scenario = CHAOS_SCENARIOS.find((s) => s.id === c.scenario)?.name ?? c.scenario;
    const verdict = c.correct === null ? '' : c.correct ? ' The epicenter matches the injected fault.' : ` The detected epicenter (${c.detectedEpicenter ? nameOf(c.detectedEpicenter) : 'none'}) does not match the injected fault.`;
    L.push(`- A chaos run, “${scenario}”${c.target ? ` on ${c.target}` : ''}, started at ${utcStamp(c.startedAt)}.${verdict}`);
  }
  L.push('');

  L.push('## Detection', '');
  if (first) L.push(`- **First alert:** ${utcStamp(first.startedAt)}, ${first.severity} ${kindOf(first)} on ${first.nodeId}: ${first.message}`);
  else L.push('- No alerts are recorded for this incident.');
  if (detail.chaos?.timeToDetectMs != null) L.push(`- **Time to detect:** ${spanText(detail.chaos.timeToDetectMs)} after the fault was injected`);
  L.push('');

  L.push('## Timeline (UTC)', '');
  // Alerts repeat per node; keep the first on each service, and everything that is not an alert.
  const seen = new Set<string>();
  const serviceOfNode = new Map(detail.alerts.map((a) => [a.nodeId, a.serviceId]));
  const serviceIn = (text: string): string => {
    for (const [node, svc] of serviceOfNode) if (text.includes(node)) return svc;
    return text;
  };
  const key = detail.timeline.filter((e) => {
    if (e.kind !== 'alert' && e.kind !== 'resolve') return true;
    const k = `${e.kind}|${serviceIn(e.text)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const e of key.slice(0, TIMELINE_MAX)) L.push(`- ${utcTime(e.ts)} ${e.kind === 'note' ? `${e.user?.name ?? 'Responder'}: ` : ''}${e.text}`);
  if (key.length > TIMELINE_MAX) L.push(`- … ${key.length - TIMELINE_MAX} more entries in the incident room`);
  if (!key.length) L.push('- No entries.');
  L.push('');

  L.push('## Responder notes', '');
  if (notes.length) for (const n of notes) L.push(`- ${utcTime(n.ts)} ${n.user?.name ?? 'Responder'}: ${n.text}`);
  else L.push('- None recorded.');
  L.push('');

  if (similar.length) {
    L.push('## Similar past incidents', '');
    for (const s of similar) {
      L.push(`- ${s.incident.title || s.incident.id} (${utcStamp(s.incident.startedAt)}${s.durationMs !== null ? `, lasted ${spanText(s.durationMs)}` : ''}): ${s.reasons.join('; ').toLowerCase()}`);
    }
    L.push('');
  }

  L.push('## Follow-ups', '');
  if (checks.length) for (const c of checks) L.push(`- [ ] ${c.title}. ${c.detail}`);
  else L.push('- [ ] None suggested.');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------- all together

export function buildInsights(detail: IncidentDetailDTO, candidates: readonly InsightCandidate[], now: number): IncidentInsightsDTO {
  const evidence = explainEpicenter(detail, detail.alerts);
  const checks = suggestChecks(detail, detail.alerts, detail.chaos, evidence);
  const similar = rankSimilar({ id: detail.id, epicenter: detail.epicenter, affected: detail.affected, kinds: alertKinds(detail.alerts) }, candidates);
  return { incidentId: detail.id, generatedAt: now, evidence, checks, similar, postmortem: buildPostmortem(detail, evidence, checks, similar, now) };
}
