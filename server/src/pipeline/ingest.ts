// The per-event part of the ingest path (plan §8.1 step 5), free of HTTP so it can be unit-tested:
// validate → time window → ownership → dedup → aggregate → touch state. No database access.
import {
  MAX_AGE_MS,
  MAX_FUTURE_MS,
  TelemetryEventSchema,
  type IngestResponse,
} from '@epicenter/shared';
import type { Aggregator } from './aggregator';
import type { Dedup } from './dedup';
import type { NodeRegistry } from './nodeRegistry';
import type { PipelineCounters } from './pipelineStats';
import type { StateStore } from './stateStore';

export interface PipelineCore {
  registry: NodeRegistry;
  dedup: Dedup;
  aggregator: Aggregator;
  state: StateStore;
  counters: PipelineCounters;
}

export type RejectReason = 'schema' | 'future' | 'too_old' | 'not_owned' | 'unknown_node' | 'stale' | 'expired';

export interface IngestResult extends IngestResponse {
  /** Count per rejection reason (debugging and tests). */
  reasons: Partial<Record<RejectReason, number>>;
}

/**
 * Processes a batch's raw events for an agent that owns node ids starting with `nodePrefix`.
 * `accepted` counts every event that was folded into a bucket; `late` is the subset that arrived out of
 * order or corrected an already-finalized bucket.
 */
export function ingestEvents(core: PipelineCore, events: unknown[], nodePrefix: string, now: number): IngestResult {
  const r: IngestResult = { accepted: 0, duplicate: 0, late: 0, rejected: 0, reasons: {} };
  const reject = (why: RejectReason) => {
    r.rejected++;
    r.reasons[why] = (r.reasons[why] ?? 0) + 1;
  };
  let outOfOrder = 0;
  let corrected = 0;
  let stale = 0;

  for (const raw of events) {
    const parsed = TelemetryEventSchema.safeParse(raw);
    if (!parsed.success) {
      reject('schema');
      continue;
    }
    const e = parsed.data;
    if (e.ts > now + MAX_FUTURE_MS) {
      reject('future');
      continue;
    }
    if (e.ts < now - MAX_AGE_MS) {
      reject('too_old');
      continue;
    }
    if (!e.nodeId.startsWith(nodePrefix)) {
      reject('not_owned');
      continue;
    }
    if (!core.registry.resolve(e.nodeId)) {
      reject('unknown_node');
      continue;
    }

    const d = core.dedup.check(e);
    if (d === 'duplicate') {
      r.duplicate++;
      continue;
    }
    if (d === 'stale') {
      stale++;
      reject('stale');
      continue;
    }

    const a = core.aggregator.add(e, now);
    if (a === 'expired') {
      reject('expired');
      continue;
    }
    r.accepted++;
    const isLate = d === 'accepted-out-of-order' || a === 'late';
    if (isLate) r.late++;
    if (d === 'accepted-out-of-order') outOfOrder++;
    if (a === 'late') corrected++;
    core.state.touch(e, now);
  }

  const c = core.counters;
  c.add('accepted', r.accepted);
  c.add('duplicate', r.duplicate);
  c.add('outOfOrder', outOfOrder);
  c.add('lateCorrected', corrected);
  c.add('stale', stale);
  c.add('rejected', r.rejected - stale);
  return r;
}
