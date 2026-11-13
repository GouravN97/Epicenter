import { Schema, model, type InferSchemaType } from 'mongoose';
import { SERVICE_IDS, TEAMS } from '@epicenter/shared';

const nodeSchema = new Schema(
  {
    nodeId: { type: String, required: true },
    serviceId: { type: String, enum: SERVICE_IDS, required: true },
    team: { type: String, enum: TEAMS, required: true },
    region: { type: String, required: true },
    az: { type: String, required: true },
    firstSeen: { type: Date, default: () => new Date() },
    lastSeen: { type: Date, default: null },
  },
  { collection: 'nodes', versionKey: false },
);
nodeSchema.index({ nodeId: 1 }, { unique: true });
nodeSchema.index({ serviceId: 1 });

export type NodeRecord = InferSchemaType<typeof nodeSchema>;
export const NodeModel = model('Node', nodeSchema);
