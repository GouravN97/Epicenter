// Persists and broadcasts the correlator's incidents, re-links alerts on merges, and records the chaos
// scorecard. Writes are chained per incident, off the hot path.
import { Types } from 'mongoose';
import type { AlertDTO, IncidentDTO, Team, TimelineEntry } from '@epicenter/shared';
import { AlertModel, ChaosRunModel, IncidentModel } from '../db/models';
import type { AlertStore } from './alertStore';
import { incidentTeams, toIncidentDTO, type Correlator, type Incident } from './correlator';

export interface IncidentEmitter {
  incident(event: 'incident:new' | 'incident:upd', dto: IncidentDTO, teams: Team[]): void;
}

export const timelineToDoc = (e: TimelineEntry) => ({
  ts: new Date(e.ts),
  kind: e.kind,
  text: e.text,
  userId: e.user ? new Types.ObjectId(e.user.id) : null,
  userName: e.user?.name ?? null,
});

export function incidentToDoc(i: Incident) {
  return {
    title: i.title,
    state: i.state,
    startedAt: new Date(i.startedAt),
    endedAt: i.endedAt ? new Date(i.endedAt) : null,
    lastAlertAt: new Date(i.lastAlertAt),
    epicenter: i.epicenter,
    confidence: i.confidence,
    affected: i.affected,
    blastRadius: i.blastRadius,
    teams: incidentTeams(i),
    alertIds: [...i.alerts.keys()].map((id) => new Types.ObjectId(id)),
    chaosRunId: i.chaos ? new Types.ObjectId(i.chaos.runId) : null,
    mergedInto: i.mergedInto ? new Types.ObjectId(i.mergedInto) : null,
    timeline: i.timeline.map(timelineToDoc),
  };
}

export class IncidentStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly emit: IncidentEmitter,
    private readonly alerts: AlertStore,
    /** Live alert object held by the detector (to update incidentId in place on merges). */
    private readonly liveAlert: (id: string) => AlertDTO | undefined,
  ) {}

  attach(c: Correlator): void {
    c.on({
      open: (inc) => this.save(inc, 'incident:new'),
      update: (inc) => this.save(inc, 'incident:upd'),
      merged: (from, into) => {
        // In-memory alerts first (they are what the detector will later resolve), then any persisted ones.
        for (const id of from.alerts.keys()) {
          const a = this.liveAlert(id);
          if (a) {
            a.incidentId = into.id;
            this.alerts.changed(a);
          }
        }
        this.chain(from.id, () =>
          AlertModel.updateMany({ incidentId: new Types.ObjectId(from.id) }, { $set: { incidentId: new Types.ObjectId(into.id) } }),
        );
        this.save(into, 'incident:upd');
      },
      scorecard: (link) => {
        this.chain(`chaos:${link.runId}`, () =>
          ChaosRunModel.updateOne(
            { _id: new Types.ObjectId(link.runId) },
            { $set: { detectedAt: new Date(link.detectedAt), detectedEpicenter: link.detectedEpicenter, correct: link.correct } },
          ),
        );
      },
    });
  }

  /** Persists the whole incident (upsert) and broadcasts it. Also used after a note is added. */
  save(inc: Incident, event: 'incident:new' | 'incident:upd'): void {
    this.emit.incident(event, toIncidentDTO(inc), incidentTeams(inc));
    const doc = incidentToDoc(inc);
    this.chain(inc.id, () => IncidentModel.updateOne({ _id: new Types.ObjectId(inc.id) }, { $set: doc }, { upsert: true }));
  }

  chain(key: string, op: () => Promise<unknown>): void {
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(op)
      .catch((err) => console.error(`[incidents] write ${key} failed:`, err instanceof Error ? err.message : err))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  async drain(): Promise<void> {
    while (this.chains.size) await Promise.all(this.chains.values());
  }
}

/** Incidents left open by a previous process can never resolve; close them on boot. */
export async function closeStaleIncidents(now = new Date()): Promise<number> {
  const r = await IncidentModel.updateMany(
    { state: 'open' },
    { $set: { state: 'resolved', endedAt: now }, $push: { timeline: { ts: now, kind: 'system', text: 'Closed at server restart', userId: null, userName: null } } },
  );
  return r.modifiedCount;
}
