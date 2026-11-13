// Chaos scenarios on the simulator side (plan §8.9). The server pushes chaos:start / chaos:stop over
// /control; this turns the set of active runs into model effects, tick-rate changes and transport behaviour.
// The detection the scenarios are meant to trigger is never scripted: it emerges from the model and the
// server's pipeline.
import { isServiceId, type ChaosCommand, type ChaosScenarioId, type IngestBatch } from '@epicenter/shared';
import type { Transport } from './agent';
import { noEffects, type Effects, type World } from './world';

export interface ActiveChaos {
  runId: string;
  scenario: ChaosScenarioId;
  target: string | null;
  endsAt: number;
}

/** Effect sizes (plan §8.9 table). */
export const CHAOS = {
  cpuSpikeAdd: 60,
  /**
   * +60 alone leaves a node at ~89–98% depending on time-of-day load, and noise dips below the 90% threshold
   * keep resetting its 10-point streak. A runaway process pins the CPU, so the spike also holds a floor.
   */
  cpuSpikeFloor: 97,
  memLeakPerSec: 0.25,
  slowDbLatMul: 8,
  cacheOutageErr: 60,
  surgeRpsMul: 10,
  surgeHzMul: 5,
  stormCopies: 3,
  stormDelayFraction: 0.1,
  /**
   * The plan says 1.5 s, but a bucket only finalizes 1 s (its width) + 2 s (AGG_GRACE_MS) after it starts,
   * so a 1.5 s delay always lands in time and never exercises late correction. 4 s reliably arrives after
   * finalization, so the server must correct the bucket (lateCorrected climbs, rev > 0).
   */
  stormDelayMs: 4000,
} as const;

/** Combines every active run into one Effects value. Overlapping runs stack. */
export function composeEffects(active: readonly ActiveChaos[]): Effects {
  const e = noEffects();
  const node = (id: string) => (e.node[id] ??= {});
  for (const r of active) {
    const t = r.target;
    switch (r.scenario) {
      case 'cpu-spike':
        if (t) {
          node(t).cpuAdd = (node(t).cpuAdd ?? 0) + CHAOS.cpuSpikeAdd;
          node(t).cpuFloor = CHAOS.cpuSpikeFloor;
        }
        break;
      case 'memory-leak':
        if (t) node(t).memRate = (node(t).memRate ?? 0) + CHAOS.memLeakPerSec;
        break;
      case 'node-kill':
        if (t) node(t).killed = true;
        break;
      case 'slow-db':
        if (t && isServiceId(t)) e.service[t] = { ...e.service[t], latMul: (e.service[t]?.latMul ?? 1) * CHAOS.slowDbLatMul };
        break;
      case 'cache-outage':
        if (t && isServiceId(t)) e.service[t] = { ...e.service[t], errAdd: (e.service[t]?.errAdd ?? 0) + CHAOS.cacheOutageErr };
        break;
      case 'traffic-surge':
        e.rpsMul *= CHAOS.surgeRpsMul;
        break;
      // duplicate-storm and malformed-flood act on the transport, not the model.
    }
  }
  return e;
}

/** Tick-rate multiplier: traffic-surge raises the sample rate ×5 (capped, e.g. lower on a small host). */
export const hzMultiplier = (active: readonly ActiveChaos[], cap: number): number =>
  active.some((r) => r.scenario === 'traffic-surge') ? Math.min(cap, CHAOS.surgeHzMul) : 1;

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * duplicate-storm transport: while active, every batch is sent three times with events shuffled, and ~10% of
 * events are held back and sent CHAOS.stormDelayMs later (late enough to land after their bucket was
 * finalized, so the server must correct it). The agent's own result is the first copy's.
 */
export function stormTransport(
  inner: Transport,
  isStorm: () => boolean,
  rand: () => number = Math.random,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms).unref(),
): Transport {
  return async (batch) => {
    if (!isStorm()) return inner(batch);
    const late = new Set(batch.events.filter(() => rand() < CHAOS.stormDelayFraction));
    const now = batch.events.filter((e) => !late.has(e));
    const copy = (events: IngestBatch['events']): IngestBatch => ({ ...batch, events: shuffled(events, rand) });
    const ignore = () => undefined;
    if (late.size) {
      schedule(() => void inner({ ...copy([...late]), sentAt: Date.now() }).catch(ignore), CHAOS.stormDelayMs);
    }
    if (now.length === 0) return { status: 202 };
    const first = inner(copy(now));
    for (let i = 1; i < CHAOS.stormCopies; i++) void inner(copy(now)).catch(ignore);
    return first;
  };
}

export interface ChaosHost {
  world: World;
  /** Restarts a node's agent identity (new bootId, seq 0), as a real process restart would. */
  restartNode(nodeId: string): void;
  setHzMultiplier(mul: number): void;
  startFlood(): void;
  stopFlood(): void;
  log(line: string): void;
}

export class ChaosController {
  private readonly active = new Map<string, ActiveChaos>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly host: ChaosHost,
    private readonly maxHzMul: number = CHAOS.surgeHzMul,
  ) {}

  list(): ActiveChaos[] {
    return [...this.active.values()];
  }

  isStorm(): boolean {
    for (const r of this.active.values()) if (r.scenario === 'duplicate-storm') return true;
    return false;
  }

  start(cmd: ChaosCommand): void {
    if (this.active.has(cmd.runId)) return; // re-sent on reconnect
    const remaining = cmd.endsAt - Date.now();
    if (remaining <= 0) return;
    this.active.set(cmd.runId, { runId: cmd.runId, scenario: cmd.scenario, target: cmd.target, endsAt: cmd.endsAt });
    // Safety net: end on our own if the server never says stop (e.g. it restarted).
    const t = setTimeout(() => this.stop(cmd.runId), remaining + 2_000);
    t.unref();
    this.timers.set(cmd.runId, t);
    if (cmd.scenario === 'malformed-flood') this.host.startFlood();
    this.host.log(`[sim] chaos start ${cmd.scenario}${cmd.target ? ` → ${cmd.target}` : ''} for ${cmd.durationSec}s`);
    this.apply();
  }

  /** Stops one run, or all of them when runId is omitted. */
  stop(runId?: string): void {
    const ids = runId ? [runId] : [...this.active.keys()];
    for (const id of ids) {
      const r = this.active.get(id);
      if (!r) continue;
      this.active.delete(id);
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      if (r.scenario === 'malformed-flood' && ![...this.active.values()].some((x) => x.scenario === 'malformed-flood')) this.host.stopFlood();
      // Recovery is a restart: the killed node comes back with a new boot, the leaking process is replaced.
      if (r.target && (r.scenario === 'node-kill' || r.scenario === 'memory-leak')) {
        this.host.world.resetNode(r.target);
        this.host.restartNode(r.target);
      }
      this.host.log(`[sim] chaos end ${r.scenario}${r.target ? ` → ${r.target}` : ''}`);
    }
    this.apply();
  }

  private apply(): void {
    const list = this.list();
    this.host.world.effects = composeEffects(list);
    this.host.setHzMultiplier(hzMultiplier(list, this.maxHzMul));
  }
}
