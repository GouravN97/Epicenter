// Correlator (plan §8.7): groups related alerts into one incident, names the epicenter (the deepest
// anomalous service in the dependency graph) and its blast radius, and links a chaos run for the scorecard.
// Pure in-memory logic; incidentStore persists and broadcasts.
import {
  CHAOS_LINK_WINDOW_MS,
  INCIDENT_JOIN_WINDOW_MS,
  INCIDENT_RESOLVE_QUIET_MS,
  SERVICE_BY_ID,
  isServiceId,
  neighbours,
  teamOfService,
  transitiveDependents,
  transitiveDeps,
  type AlertDTO,
  type ChaosScenarioId,
  type IncidentDTO,
  type ServiceId,
  type Severity,
  type Team,
  type TimelineEntry,
} from '@epicenter/shared';

/** Timeline entries kept per incident (notes beyond this push the oldest system entries out). */
export const TIMELINE_CAP = 500;

interface IncAlert {
  id: string;
  serviceId: ServiceId;
  startedAt: number;
  severity: Severity;
  label: string;
  firing: boolean;
}

export interface ChaosLink {
  runId: string;
  scenario: ChaosScenarioId;
  /** Service the fault was injected into; null for scenarios without one (traffic-surge, ...). */
  service: ServiceId | null;
  startedAt: number;
  detectedAt: number;
  detectedEpicenter: string | null;
  correct: boolean | null;
}

export interface Incident {
  id: string;
  title: string;
  state: 'open' | 'resolved';
  startedAt: number;
  endedAt: number | null;
  lastAlertAt: number;
  epicenter: ServiceId | null;
  confidence: number;
  /** Every service with an alert in this incident (firing or resolved). */
  affected: ServiceId[];
  blastRadius: ServiceId[];
  alerts: Map<string, IncAlert>;
  timeline: TimelineEntry[];
  chaos: ChaosLink | null;
  /** When the last firing alert resolved; null while any alert fires. */
  quietSince: number | null;
  /** Set when this incident was merged into another one. */
  mergedInto?: string;
}

export interface ChaosCandidate {
  runId: string;
  scenario: ChaosScenarioId;
  service: ServiceId | null;
  startedAt: number;
}

export interface CorrelatorListeners {
  open?: (inc: Incident) => void;
  update?: (inc: Incident) => void;
  /** An alert was attached to an incident (alert.incidentId is now set). */
  linked?: (a: AlertDTO, inc: Incident) => void;
  /** The linked chaos run's scorecard changed. */
  scorecard?: (link: ChaosLink, inc: Incident) => void;
  /** `from` was merged into `into`; its alerts now belong to `into` (re-link them). */
  merged?: (from: Incident, into: Incident) => void;
}

const SEV_RANK: Record<Severity, number> = { warn: 1, crit: 2 };

export const toIncidentDTO = (i: Incident): IncidentDTO => ({
  id: i.id,
  title: i.title,
  state: i.state,
  epicenter: i.epicenter,
  confidence: i.confidence,
  affected: [...i.affected],
  blastRadius: [...i.blastRadius],
  startedAt: i.startedAt,
  endedAt: i.endedAt,
});

/** Teams that may see an incident: owners of affected and blast-radius services. */
export const incidentTeams = (i: Pick<Incident, 'affected' | 'blastRadius'>): Team[] => [
  ...new Set([...i.affected, ...i.blastRadius].map(teamOfService)),
];

/**
 * Epicenter analysis over the services with alerts in the incident (§8.7):
 *   candidates = anomalous services none of whose (transitive) dependencies is anomalous;
 *   epicenter  = earliest-onset candidate (ties: higher severity, then more alerts, then deeper layer);
 *   blast      = everything that transitively depends on the epicenter;
 *   confidence = share of anomalous services explained by the epicenter (itself or its blast radius).
 */
export function analyse(
  firing: { serviceId: ServiceId; startedAt: number; severity: Severity }[],
): { epicenter: ServiceId; blastRadius: ServiceId[]; confidence: number } | null {
  const A = new Set(firing.map((a) => a.serviceId));
  if (A.size === 0) return null;
  const candidates = [...A].filter((s) => ![...transitiveDeps(s)].some((d) => A.has(d)));
  const stats = (s: ServiceId) => {
    const own = firing.filter((a) => a.serviceId === s);
    return {
      onset: Math.min(...own.map((a) => a.startedAt)),
      sev: Math.max(...own.map((a) => SEV_RANK[a.severity])),
      count: own.length,
      layer: SERVICE_BY_ID[s].layer,
    };
  };
  const epicenter = candidates
    .map((s) => ({ s, ...stats(s) }))
    .sort((a, b) => a.onset - b.onset || b.sev - a.sev || b.count - a.count || b.layer - a.layer)[0]!.s;
  const blast = transitiveDependents(epicenter);
  const explained = [...A].filter((s) => s === epicenter || blast.has(s)).length;
  return { epicenter, blastRadius: [...blast], confidence: Math.round((explained / A.size) * 100) / 100 };
}

/** Picks the chaos run to link: the latest one that started within CHAOS_LINK_WINDOW_MS before the incident. */
export function pickChaosRun(incStartedAt: number, runs: ChaosCandidate[]): ChaosCandidate | null {
  const eligible = runs.filter((r) => r.startedAt <= incStartedAt && incStartedAt - r.startedAt <= CHAOS_LINK_WINDOW_MS);
  return eligible.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export class Correlator {
  private readonly open = new Map<string, Incident>();
  private readonly listeners: CorrelatorListeners[] = [];
  /** Chaos runs already linked to an incident (one incident per run). */
  private readonly linkedRuns = new Set<string>();

  constructor(
    private readonly newId: () => string,
    /** Recent chaos runs (active or just ended) to consider for the scorecard. */
    private readonly chaosRuns: () => ChaosCandidate[] = () => [],
  ) {}

  on(l: CorrelatorListeners): void {
    this.listeners.push(l);
  }

  get(id: string): Incident | undefined {
    return this.open.get(id);
  }

  openIncidents(): Incident[] {
    return [...this.open.values()];
  }

  onAlertFired(a: AlertDTO, now: number): Incident | null {
    if (!isServiceId(a.serviceId)) return null;
    const svc = a.serviceId;
    const joinable = this.findJoinable(svc, now);
    // An alert adjacent to several open incidents connects them: one fault seen from different sides (e.g.
    // orders-api and worker both alert before db, which they share). Merge them into the oldest.
    let inc = joinable[0];
    for (const other of joinable.slice(1)) this.merge(inc!, other, now);
    const created = !inc;
    if (!inc) {
      inc = {
        id: this.newId(),
        title: '',
        state: 'open',
        startedAt: a.startedAt,
        endedAt: null,
        lastAlertAt: now,
        epicenter: null,
        confidence: 0,
        affected: [],
        blastRadius: [],
        alerts: new Map(),
        timeline: [],
        chaos: null,
        quietSince: null,
      };
      this.open.set(inc.id, inc);
      this.note(inc, { ts: now, kind: 'system', text: 'Incident opened' });
      const run = pickChaosRun(inc.startedAt, this.chaosRuns().filter((r) => !this.linkedRuns.has(r.runId)));
      if (run) {
        this.linkedRuns.add(run.runId);
        inc.chaos = { ...run, detectedAt: now, detectedEpicenter: null, correct: null };
        this.note(inc, { ts: now, kind: 'chaos', text: `Linked to chaos run ${run.scenario}${run.service ? ` on ${run.service}` : ''}` });
      }
    }
    inc.lastAlertAt = now;
    inc.quietSince = null;
    inc.alerts.set(a.id, { id: a.id, serviceId: svc, startedAt: a.startedAt, severity: a.severity, label: `${a.rule}/${a.metric}`, firing: true });
    if (!inc.affected.includes(svc)) inc.affected.push(svc);
    a.incidentId = inc.id;
    this.note(inc, { ts: now, kind: 'alert', text: `${a.severity} ${a.rule} on ${a.nodeId}: ${a.message}` });
    this.recompute(inc, now);
    for (const l of this.listeners) l.linked?.(a, inc);
    for (const l of this.listeners) (created ? l.open : l.update)?.(inc);
    return inc;
  }

  onAlertResolved(a: AlertDTO, now: number): void {
    const inc = a.incidentId ? this.open.get(a.incidentId) : undefined;
    const ia = inc?.alerts.get(a.id);
    if (!inc || !ia || !ia.firing) return;
    ia.firing = false;
    this.note(inc, { ts: now, kind: 'resolve', text: `Resolved ${ia.label} on ${a.nodeId}` });
    if (![...inc.alerts.values()].some((x) => x.firing)) inc.quietSince = now;
    // No re-analysis on resolve: the root usually recovers first (chaos stopped, db healthy) while its
    // callers alert a few seconds longer, and analysing only what is still firing would then "move" the
    // epicenter onto a symptom.
    for (const l of this.listeners) l.update?.(inc);
  }

  /** Resolves incidents with no firing alert for INCIDENT_RESOLVE_QUIET_MS. Call every second or so. */
  tick(now: number): void {
    for (const inc of this.open.values()) {
      if (inc.quietSince !== null && now - inc.quietSince >= INCIDENT_RESOLVE_QUIET_MS) {
        inc.state = 'resolved';
        inc.endedAt = now;
        this.note(inc, { ts: now, kind: 'system', text: 'Incident resolved: no firing alerts for 30 s' });
        this.open.delete(inc.id);
        for (const l of this.listeners) l.update?.(inc);
      }
    }
  }

  /** Adds a timeline entry (also used for user notes). */
  note(inc: Incident, e: TimelineEntry): void {
    inc.timeline.push(e);
    if (inc.timeline.length > TIMELINE_CAP) {
      // Drop the oldest non-note entry; notes are what people wrote, keep them.
      const i = inc.timeline.findIndex((x) => x.kind !== 'note');
      inc.timeline.splice(i >= 0 ? i : 0, 1);
    }
  }

  /** Open incidents this service's alert may join (§8.7 rule), oldest first. */
  private findJoinable(svc: ServiceId, now: number): Incident[] {
    const out: Incident[] = [];
    for (const inc of this.open.values()) {
      if (now - inc.lastAlertAt >= INCIDENT_JOIN_WINDOW_MS) continue;
      const near = new Set(inc.affected.flatMap((s) => [s, ...neighbours(s)]));
      if (near.has(svc)) out.push(inc);
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Moves everything from `from` into `into` and closes `from` as merged. */
  private merge(into: Incident, from: Incident, now: number): void {
    for (const [id, a] of from.alerts) into.alerts.set(id, a);
    for (const s of from.affected) if (!into.affected.includes(s)) into.affected.push(s);
    into.startedAt = Math.min(into.startedAt, from.startedAt);
    into.lastAlertAt = Math.max(into.lastAlertAt, from.lastAlertAt);
    if (!into.chaos && from.chaos) into.chaos = from.chaos;
    into.timeline = [...into.timeline, ...from.timeline].sort((x, y) => x.ts - y.ts);
    while (into.timeline.length > TIMELINE_CAP) into.timeline.shift();
    this.note(into, { ts: now, kind: 'system', text: `Merged incident ${from.id} (${from.affected.join(', ')})` });

    this.open.delete(from.id);
    from.state = 'resolved';
    from.endedAt = now;
    from.mergedInto = into.id;
    this.note(from, { ts: now, kind: 'system', text: `Merged into incident ${into.id}` });
    for (const l of this.listeners) l.merged?.(from, into);
    for (const l of this.listeners) l.update?.(from);
  }

  /**
   * Re-runs the epicenter analysis over every alert this incident has seen (firing or since resolved).
   * Deviation from §8.7's "firing alerts only", for stability: see onAlertResolved.
   */
  private recompute(inc: Incident, now: number): void {
    const r = analyse([...inc.alerts.values()]);
    if (r) {
      if (r.epicenter !== inc.epicenter) {
        this.note(inc, { ts: now, kind: 'epicenter', text: `Epicenter: ${r.epicenter}` });
      }
      inc.epicenter = r.epicenter;
      inc.blastRadius = r.blastRadius;
      inc.confidence = r.confidence;
    }
    // Title from the epicenter's dominant alert kind.
    if (inc.epicenter) {
      const own = [...inc.alerts.values()].filter((a) => a.serviceId === inc.epicenter);
      const counts = new Map<string, number>();
      for (const a of own) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'anomaly';
      const n = inc.affected.length;
      inc.title = `${inc.epicenter}: ${dominant} — ${n} service${n === 1 ? '' : 's'} affected`;
    }
    if (inc.chaos && inc.epicenter && inc.chaos.detectedEpicenter !== inc.epicenter) {
      inc.chaos.detectedEpicenter = inc.epicenter;
      inc.chaos.correct = inc.chaos.service ? inc.epicenter === inc.chaos.service : null;
      for (const l of this.listeners) l.scorecard?.(inc.chaos, inc);
    }
  }
}
