import { Schema, Types, model, type InferSchemaType } from 'mongoose';
import { ALERT_RULES, ALERT_STATES, SEVERITIES } from '@epicenter/shared';

const alertSchema = new Schema(
  {
    /** nodeId|metric|rule — at most one firing alert per key (enforced in memory by the detector). */
    key: { type: String, required: true },
    nodeId: { type: String, required: true },
    serviceId: { type: String, required: true },
    team: { type: String, required: true },
    metric: { type: String, required: true },
    rule: { type: String, enum: ALERT_RULES, required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    state: { type: String, enum: ALERT_STATES, required: true, default: 'firing' },
    value: { type: Number, required: true },
    threshold: { type: Number, required: true },
    message: { type: String, required: true },
    startedAt: { type: Date, required: true },
    ackedBy: { type: Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    incidentId: { type: Types.ObjectId, ref: 'Incident', default: null },
  },
  { collection: 'alerts', versionKey: false },
);
alertSchema.index({ state: 1, startedAt: -1 });
alertSchema.index({ key: 1 });
alertSchema.index({ incidentId: 1 });

export type Alert = InferSchemaType<typeof alertSchema>;
export const AlertModel = model('Alert', alertSchema);
