import { Schema, model } from 'mongoose';
import { METRICS_1M_TTL_S, METRICS_1S_TTL_S } from '@epicenter/shared';

// 1-second and 1-minute rollups (§5). The hot path writes with raw `collection.bulkWrite` upserts keyed on
// the unique (nodeId, ts) index, so duplicates are impossible at the storage layer. Schemas exist mainly to
// declare indexes and to type reads.

const metric = { type: Number, required: true };

const base = {
  nodeId: { type: String, required: true },
  /** Bucket start (1 s or 1 min). */
  ts: { type: Date, required: true },
  /** Raw events folded into this bucket. */
  n: metric,
  cpu: metric,
  mem: metric,
  disk: metric,
  netIn: metric,
  netOut: metric,
  lat: metric,
  latMax: metric,
  err: metric,
  rps: metric,
  /** Correction counter: bumped each time a late event re-emits a finalized bucket. */
  rev: { type: Number, default: 0 },
};

const metric1sSchema = new Schema(base, { collection: 'metrics_1s', versionKey: false });
metric1sSchema.index({ nodeId: 1, ts: 1 }, { unique: true });
metric1sSchema.index({ ts: 1 }, { expireAfterSeconds: METRICS_1S_TTL_S });

const metric1mSchema = new Schema(
  { ...base, cpuMax: metric, memMax: metric, errMax: metric },
  { collection: 'metrics_1m', versionKey: false },
);
metric1mSchema.index({ nodeId: 1, ts: 1 }, { unique: true });
metric1mSchema.index({ ts: 1 }, { expireAfterSeconds: METRICS_1M_TTL_S });

export const Metric1sModel = model('Metric1s', metric1sSchema);
export const Metric1mModel = model('Metric1m', metric1mSchema);
