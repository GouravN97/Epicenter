// Incident reads and notes for REST and the socket layer. Open incidents are served from the correlator's
// memory (freshest); resolved ones from MongoDB.
import { Types } from 'mongoose';
import {
  type AlertDTO,
  type AuthClaims,
  type ChaosScorecard,
  type IncidentDTO,
  type IncidentDetailDTO,
  type Team,
  type TimelineEntry,
} from '@epicenter/shared';
import { AlertModel, ChaosRunModel, IncidentModel } from '../db/models';
import { HttpError } from '../http/errors';
import { docToAlert } from '../pipeline/alertStore';
import { incidentTeams, toIncidentDTO, type Correlator } from '../pipeline/correlator';
import type { Detector } from '../pipeline/detector';
import type { IncidentStore } from '../pipeline/incidentStore';
import { timelineToDoc } from '../pipeline/incidentStore';
import { visibleTeams } from '../realtime/rooms';

export interface IncidentsPage {
  incidents: IncidentDTO[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: number | null;
}

type IncidentDoc = {
  _id: Types.ObjectId;
  title: string;
  state: 'open' | 'resolved';
  startedAt: Date;
  endedAt: Date | null;
  epicenter: string | null;
  confidence: number;
  affected: string[];
  blastRadius: string[];
  teams: string[];
  chaosRunId: Types.ObjectId | null;
  timeline: { ts: Date; kind: TimelineEntry['kind']; text: string; userId: Types.ObjectId | null; userName: string | null }[];
};

const docToDTO = (d: IncidentDoc): IncidentDTO => ({
  id: d._id.toString(),
  title: d.title,
  state: d.state,
  epicenter: d.epicenter,
  confidence: d.confidence,
  affected: d.affected,
  blastRadius: d.blastRadius,
  startedAt: d.startedAt.getTime(),
  endedAt: d.endedAt?.getTime() ?? null,
});

const docTimeline = (d: IncidentDoc): TimelineEntry[] =>
  d.timeline.map((e) => ({
    ts: e.ts.getTime(),
    kind: e.kind,
    text: e.text,
    user: e.userId ? { id: e.userId.toString(), name: e.userName ?? '' } : null,
  }));

const TEAMS_CACHE_MAX = 1_000;

export class IncidentService {
  /** incident id → teams, for incidents no longer in the correlator (room ACL needs a sync answer). */
  private readonly teamsCache = new Map<string, Team[]>();

  constructor(
    private readonly correlator: Correlator,
    private readonly detector: Detector,
    private readonly store: IncidentStore,
  ) {}

  /** Teams an incident touches, if known in memory. Used by canJoin for incident:<id> rooms. */
  teamsOf(id: string): Team[] | undefined {
    const live = this.correlator.get(id);
    return live ? incidentTeams(live) : this.teamsCache.get(id);
  }

  private remember(id: string, teams: Team[]): void {
    if (this.teamsCache.size >= TEAMS_CACHE_MAX) this.teamsCache.delete(this.teamsCache.keys().next().value!);
    this.teamsCache.set(id, teams);
  }

  private assertVisible(user: AuthClaims, teams: readonly string[]): void {
    const mine = visibleTeams(user);
    if (!teams.some((t) => mine.includes(t as Team))) throw new HttpError(403, 'forbidden', 'Incident does not touch your teams');
  }

  async list(user: AuthClaims, q: { state?: 'open' | 'resolved'; limit: number; before?: number }): Promise<IncidentsPage> {
    const filter: Record<string, unknown> = { teams: { $in: visibleTeams(user) }, mergedInto: null };
    if (q.state) filter.state = q.state;
    if (q.before !== undefined) filter.startedAt = { $lt: new Date(q.before) };
    const docs = await IncidentModel.find(filter).sort({ startedAt: -1, _id: -1 }).limit(q.limit + 1).lean<IncidentDoc[]>();
    const page = docs.slice(0, q.limit).map((d) => {
      const live = this.correlator.get(d._id.toString());
      return live ? toIncidentDTO(live) : docToDTO(d);
    });
    return { incidents: page, nextBefore: docs.length > q.limit ? page.at(-1)!.startedAt : null };
  }

  async detail(user: AuthClaims, id: string): Promise<IncidentDetailDTO> {
    const live = this.correlator.get(id);
    let base: IncidentDTO;
    let timeline: TimelineEntry[];
    let teams: Team[];
    let chaosRunId: string | null;
    if (live) {
      base = toIncidentDTO(live);
      timeline = [...live.timeline];
      teams = incidentTeams(live);
      chaosRunId = live.chaos?.runId ?? null;
    } else {
      const d = await IncidentModel.findById(id).lean<IncidentDoc>();
      if (!d) throw new HttpError(404, 'not_found', 'No such incident');
      base = docToDTO(d);
      timeline = docTimeline(d);
      teams = d.teams as Team[];
      chaosRunId = d.chaosRunId?.toString() ?? null;
    }
    this.assertVisible(user, teams);
    this.remember(id, teams);

    const alertDocs = await AlertModel.find({ incidentId: new Types.ObjectId(id) }).sort({ startedAt: 1 }).lean();
    const alerts: AlertDTO[] = alertDocs.map(
      (d) => this.detector.getActive(d._id.toString()) ?? docToAlert(d as unknown as Parameters<typeof docToAlert>[0]),
    );
    return { ...base, alerts, timeline, chaos: chaosRunId ? await this.scorecard(chaosRunId, live?.chaos ?? null) : null };
  }

  private async scorecard(runId: string, memory: { detectedAt: number; detectedEpicenter: string | null; correct: boolean | null } | null): Promise<ChaosScorecard | null> {
    const run = await ChaosRunModel.findById(runId).lean();
    if (!run) return null;
    const detectedAt = memory?.detectedAt ?? run.detectedAt?.getTime() ?? null;
    const startedAt = run.startedAt.getTime();
    return {
      runId,
      scenario: run.scenario,
      target: run.target ?? null,
      startedAt,
      detectedAt,
      timeToDetectMs: detectedAt !== null ? detectedAt - startedAt : null,
      detectedEpicenter: memory?.detectedEpicenter ?? run.detectedEpicenter ?? null,
      correct: memory ? memory.correct : (run.correct ?? null),
    };
  }

  /** Appends a note; returns the timeline entry to broadcast as incident:note. */
  async addNote(user: AuthClaims, id: string, text: string): Promise<TimelineEntry> {
    const entry: TimelineEntry = { ts: Date.now(), kind: 'note', text, user: { id: user.sub, name: user.name } };
    const live = this.correlator.get(id);
    if (live) {
      this.assertVisible(user, incidentTeams(live));
      this.correlator.note(live, entry);
      this.store.save(live, 'incident:upd');
      return entry;
    }
    const d = await IncidentModel.findById(id, { teams: 1 }).lean<Pick<IncidentDoc, 'teams'>>();
    if (!d) throw new HttpError(404, 'not_found', 'No such incident');
    this.assertVisible(user, d.teams);
    await IncidentModel.updateOne({ _id: new Types.ObjectId(id) }, { $push: { timeline: timelineToDoc(entry) } });
    return entry;
  }
}
