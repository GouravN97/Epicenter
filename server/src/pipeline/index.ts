// Wires the in-memory pipeline together. Later tasks subscribe to `aggregator.on(...)`: writer (A6),
// broadcaster (A5), detector (A7).
import { AGG_FINALIZE_INTERVAL_MS, buildFleet } from '@epicenter/shared';
import { Aggregator } from './aggregator';
import { Dedup } from './dedup';
import type { PipelineCore } from './ingest';
import { NodeRegistry } from './nodeRegistry';
import { PipelineCounters } from './pipelineStats';
import { StateStore } from './stateStore';

export interface Pipeline extends PipelineCore {
  start(): void;
  stop(): void;
}

/** `knownNodes`: node ids from the `nodes` collection; the canonical fleet always comes first. */
export function createPipeline(knownNodes: string[] = []): Pipeline {
  const fleet = buildFleet().map((n) => n.nodeId);
  const fleetSet = new Set(fleet);
  const registry = new NodeRegistry([...fleet, ...knownNodes.filter((id) => !fleetSet.has(id))].map((nodeId) => ({ nodeId })));
  const aggregator = new Aggregator();
  const state = new StateStore();
  const counters = new PipelineCounters();
  aggregator.on({ point: (p) => state.onPoint(p) });

  let rollTimer: NodeJS.Timeout | null = null;
  return {
    registry,
    dedup: new Dedup(),
    aggregator,
    state,
    counters,
    start() {
      aggregator.start(AGG_FINALIZE_INTERVAL_MS);
      rollTimer ??= setInterval(() => counters.roll(), 1000);
    },
    stop() {
      aggregator.stop();
      if (rollTimer) clearInterval(rollTimer);
      rollTimer = null;
    },
  };
}
