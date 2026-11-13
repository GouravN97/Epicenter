import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * An ingest agent. `keyHash` is sha256(key) (see lib/agentKey.ts) so the ingest path can look an agent up by
 * key without bcrypt. The three simulator agents share SIM_KEY, so `keyHash` is indexed but not unique: the
 * ingest middleware resolves key → candidate agents, then matches the batch's `agentId`.
 */
const agentSchema = new Schema(
  {
    agentId: { type: String, required: true },
    keyHash: { type: String, required: true },
    name: { type: String, required: true },
    /** The agent may only report node ids that start with this prefix. */
    nodePrefix: { type: String, required: true },
    ratePerSec: { type: Number, required: true },
    burst: { type: Number, required: true },
    enabled: { type: Boolean, default: true },
  },
  { collection: 'agents', timestamps: true, versionKey: false },
);
agentSchema.index({ agentId: 1 }, { unique: true });
agentSchema.index({ keyHash: 1 });

export type Agent = InferSchemaType<typeof agentSchema>;
export const AgentModel = model('Agent', agentSchema);
