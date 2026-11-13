import { Schema, Types, model, type InferSchemaType } from 'mongoose';
import { CHAOS_SCENARIO_IDS } from '@epicenter/shared';

const chaosRunSchema = new Schema(
  {
    scenario: { type: String, enum: CHAOS_SCENARIO_IDS, required: true },
    target: { type: String, default: null },
    params: { type: Schema.Types.Mixed, default: {} },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    startedBy: { type: Types.ObjectId, ref: 'User', required: true },
    detectedAt: { type: Date, default: null },
    detectedEpicenter: { type: String, default: null },
    correct: { type: Boolean, default: null },
  },
  { collection: 'chaos_runs', versionKey: false },
);
chaosRunSchema.index({ startedAt: -1 });

export type ChaosRun = InferSchemaType<typeof chaosRunSchema>;
export const ChaosRunModel = model('ChaosRun', chaosRunSchema);
