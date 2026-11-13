import type { RequestHandler, Response } from 'express';
import { AGENT_KEY_CACHE_MS } from '@epicenter/shared';
import { AgentModel } from '../../db/models';
import { hashAgentKey } from '../../lib/agentKey';
import { HttpError } from '../errors';

export interface AgentInfo {
  agentId: string;
  nodePrefix: string;
  ratePerSec: number;
  burst: number;
}

/** Bad keys are cached too (as empty lists), so a flood with a wrong key does not hit the database. */
const MAX_CACHE = 1_000;
const cache = new Map<string, { agents: AgentInfo[]; expires: number }>();

async function agentsForKey(key: string, now: number): Promise<AgentInfo[]> {
  const hash = hashAgentKey(key);
  const hit = cache.get(hash);
  if (hit && hit.expires > now) return hit.agents;
  const docs = await AgentModel.find({ keyHash: hash, enabled: true }, { agentId: 1, nodePrefix: 1, ratePerSec: 1, burst: 1 }).lean();
  const agents = docs.map((d) => ({ agentId: d.agentId, nodePrefix: d.nodePrefix, ratePerSec: d.ratePerSec, burst: d.burst }));
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(hash, { agents, expires: now + AGENT_KEY_CACHE_MS });
  return agents;
}

/** Drops cached keys (e.g. after an agent is created or disabled). */
export const clearAgentKeyCache = (): void => cache.clear();

/**
 * Requires `x-agent-key`. Sets `res.locals.agents` to every enabled agent with that key; the ingest handler
 * then picks the one named by the batch (the simulator's region agents share SIM_KEY).
 */
export const agentKey: RequestHandler = async (req, res, next) => {
  const key = req.header('x-agent-key');
  if (!key || key.length > 256) throw new HttpError(401, 'invalid_agent_key', 'Missing or invalid x-agent-key');
  const agents = await agentsForKey(key, Date.now());
  if (agents.length === 0) throw new HttpError(401, 'invalid_agent_key', 'Missing or invalid x-agent-key');
  res.locals.agents = agents;
  next();
};

export const agentsOf = (res: Response): AgentInfo[] => (res.locals.agents as AgentInfo[] | undefined) ?? [];
