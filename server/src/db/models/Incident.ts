import { Schema, Types, model, type InferSchemaType } from 'mongoose';
import { INCIDENT_STATES } from '@epicenter/shared';

const timelineSchema = new Schema(
  {
    ts: { type: Date, required: true },
    kind: { type: String, enum: ['alert', 'resolve', 'note', 'epicenter', 'chaos', 'system'], required: true },
    text: { type: String, required: true },
    userId: { type: Types.ObjectId, ref: 'User', default: null },
    /** Denormalized so the timeline renders without a user lookup. */
    userName: { type: String, default: null },
  },
  { _id: false },
);

const incidentSchema = new Schema(
  {
    title: { type: String, required: true },
    state: { type: String, enum: INCIDENT_STATES, required: true, default: 'open' },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    lastAlertAt: { type: Date, required: true },
    epicenter: { type: String, default: null },
    confidence: { type: Number, default: 0 },
    affected: { type: [String], default: [] },
    blastRadius: { type: [String], default: [] },
    /** Teams owning affected or blast-radius services: who may see this incident. */
    teams: { type: [String], default: [] },
    alertIds: { type: [{ type: Types.ObjectId, ref: 'Alert' }], default: [] },
    chaosRunId: { type: Types.ObjectId, ref: 'ChaosRun', default: null },
    /** Set when the correlator merged this incident into another (it is then closed). */
    mergedInto: { type: Types.ObjectId, ref: 'Incident', default: null },
    timeline: { type: [timelineSchema], default: [] },
  },
  { collection: 'incidents', versionKey: false },
);
incidentSchema.index({ state: 1, startedAt: -1 });

export type Incident = InferSchemaType<typeof incidentSchema>;
export const IncidentModel = model('Incident', incidentSchema);
