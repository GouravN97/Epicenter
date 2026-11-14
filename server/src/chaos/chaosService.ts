// Chaos Lab (plan §6.3, §8.9). Creates a chaos_runs record, pushes the command to every connected simulator
// over /control, ends the run automatically at endsAt, and keeps dashboards informed with chaos:upd.
import { Types } from 'mongoose';
import {
  CHAOS_SCENARIOS,
  isServiceId,
  type ChaosActiveRun,
  type ChaosCommand,
  type ChaosScenarioId,
  type ChaosStartBody,
  type ServiceId,
} from '@epicenter/shared';
import { ChaosRunModel } from '../db/models';
import { HttpError } from '../http/errors';
import type { NodeRegistry } from '../pipeline/nodeRegistry';
import type { Control } from '../realtime/control';

/** How long started runs stay eligible for incident linking (covers CHAOS_LINK_WINDOW_MS with margin). */
const RECENT_RUNS_MS = 10 * 60_000;

/** Node scenarios without an explicit target hit the first node of this service. */
const DEFAULT_NODE_SERVICE: Partial<Record<ChaosScenarioId, ServiceId>> = {
  'cpu-spike': 'catalog-api',
  'memory-leak': 'orders-api',
  'node-kill': 'worker',
};

export interface ResolvedTarget {
  target: string | null;
  /** Service the fault is expected to originate from (for the scorecard: correct = epicenter == this). */
  service: ServiceId | null;
}

/** Validates/defaults a scenario's target. Throws HttpError 400 for a target of the wrong kind. */
export function resolveTarget(scenario: ChaosScenarioId, target: string | undefined, registry: Pick<NodeRegistry, 'get' | 'list'>): ResolvedTarget {
  const def = CHAOS_SCENARIOS.find((s) => s.id === scenario)!;
  switch (def.targetKind) {
    case 'none':
      return { target: null, service: null };
    case 'service': {
      const t = target ?? def.defaultTarget!;
      if (!isServiceId(t)) throw new HttpError(400, 'invalid_target', `${scenario} needs a service id, got "${t}"`);
      return { target: t, service: t };
    }
    case 'node': {
      const t = target ?? registry.list.find((n) => n.serviceId === DEFAULT_NODE_SERVICE[scenario])?.nodeId;
      const node = t ? registry.get(t) : undefined;
      if (!node) throw new HttpError(400, 'invalid_target', `${scenario} needs a known node id, got "${t}"`);
      return { target: node.nodeId, service: node.serviceId };
    }
  }
}

interface ActiveRun {
  cmd: ChaosCommand;
  service: ServiceId | null;
  startedAt: number;
  timer: NodeJS.Timeout;
}

export interface ChaosRunDTO {
  id: string;
  scenario: ChaosScenarioId;
  target: string | null;
  durationSec: number;
  startedAt: number;
  endsAt: number;
  endedAt: number | null;
  startedBy: string;
  detectedAt: number | null;
  detectedEpicenter: string | null;
  correct: boolean | null;
}

export class ChaosService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly updFns: ((active: ChaosActiveRun[]) => void)[] = [];
  private readonly started: { runId: string; scenario: ChaosScenarioId; service: ServiceId | null; startedAt: number }[] = [];

  constructor(
    private readonly control: Control,
    private readonly registry: NodeRegistry,
  ) {
    // A simulator that (re)connects mid-run picks up what is still active.
    control.onSimulatorConnect((send) => {
      for (const r of this.active.values()) send(r.cmd);
    });
  }

  onUpdate(fn: (active: ChaosActiveRun[]) => void): void {
    this.updFns.push(fn);
  }

  snapshot(): ChaosActiveRun[] {
    return [...this.active.values()].map(({ cmd }) => ({ runId: cmd.runId, scenario: cmd.scenario, target: cmd.target, endsAt: cmd.endsAt }));
  }

  /** Runs started recently (active or ended) with their target service, for the correlator's scorecard. */
  recentRuns(): { runId: string; scenario: ChaosScenarioId; service: ServiceId | null; startedAt: number }[] {
    const cutoff = Date.now() - RECENT_RUNS_MS;
    while (this.started.length && this.started[0]!.startedAt < cutoff) this.started.shift();
    return [...this.started];
  }

  async start(body: ChaosStartBody, userId: string): Promise<ChaosRunDTO> {
    if (this.control.simulators() === 0) {
      throw new HttpError(503, 'no_simulator', 'No simulator is connected to /control; start one with npm run sim');
    }
    const def = CHAOS_SCENARIOS.find((s) => s.id === body.scenario)!;
    const { target, service } = resolveTarget(body.scenario, body.target, this.registry);
    for (const r of this.active.values()) {
      if (r.cmd.scenario === body.scenario && r.cmd.target === target) {
        throw new HttpError(409, 'already_running', `${body.scenario}${target ? ` on ${target}` : ''} is already running`);
      }
    }
    const durationSec = body.durationSec ?? def.defaultDurationSec;
    const startedAt = Date.now();
    const runId = new Types.ObjectId();
    const cmd: ChaosCommand = { runId: runId.toHexString(), scenario: body.scenario, target, durationSec, endsAt: startedAt + durationSec * 1000 };

    await ChaosRunModel.create({
      _id: runId,
      scenario: body.scenario,
      target,
      params: { durationSec },
      startedAt: new Date(startedAt),
      startedBy: new Types.ObjectId(userId),
    });
    const timer = setTimeout(() => void this.end(cmd.runId), durationSec * 1000);
    timer.unref();
    this.active.set(cmd.runId, { cmd, service, startedAt, timer });
    this.started.push({ runId: cmd.runId, scenario: cmd.scenario, service, startedAt });
    this.control.start(cmd);
    this.emitUpd();
    console.log(`[chaos] start ${cmd.scenario}${target ? ` → ${target}` : ''} for ${durationSec}s (run ${cmd.runId})`);
    return { id: cmd.runId, scenario: cmd.scenario, target, durationSec, startedAt, endsAt: cmd.endsAt, endedAt: null, startedBy: userId, detectedAt: null, detectedEpicenter: null, correct: null };
  }

  /** Stops every active run. Returns how many were stopped. */
  async stopAll(): Promise<number> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.end(id)));
    return ids.length;
  }

  private async end(runId: string): Promise<void> {
    const r = this.active.get(runId);
    if (!r) return;
    clearTimeout(r.timer);
    this.active.delete(runId);
    this.control.stop(runId);
    this.emitUpd();
    console.log(`[chaos] end ${r.cmd.scenario} (run ${runId})`);
    await ChaosRunModel.updateOne({ _id: runId }, { $set: { endedAt: new Date() } }).catch((err) =>
      console.error('[chaos] could not record endedAt:', err instanceof Error ? err.message : err),
    );
  }

  private emitUpd(): void {
    const s = this.snapshot();
    for (const fn of this.updFns) fn(s);
  }

  async recent(limit: number): Promise<ChaosRunDTO[]> {
    const docs = await ChaosRunModel.find().sort({ startedAt: -1 }).limit(limit).lean();
    return docs.map((d) => ({
      id: d._id.toString(),
      scenario: d.scenario,
      target: d.target ?? null,
      durationSec: (d.params as { durationSec?: number } | null)?.durationSec ?? 0,
      startedAt: d.startedAt.getTime(),
      endsAt: d.startedAt.getTime() + ((d.params as { durationSec?: number } | null)?.durationSec ?? 0) * 1000,
      endedAt: d.endedAt?.getTime() ?? null,
      startedBy: d.startedBy.toString(),
      detectedAt: d.detectedAt?.getTime() ?? null,
      detectedEpicenter: d.detectedEpicenter ?? null,
      correct: d.correct ?? null,
    }));
  }
}

/** Runs left open by a previous process can never be stopped by it; close them on boot. */
export async function closeStaleChaosRuns(now = new Date()): Promise<number> {
  const r = await ChaosRunModel.updateMany({ endedAt: null }, { $set: { endedAt: now } });
  return r.modifiedCount;
}
