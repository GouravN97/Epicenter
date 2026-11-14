// POST /api/v1/ingest (plan §6.1, §8.1). Order: agent key → load shed → token bucket → 256 kB JSON body →
// envelope validation → per-event pipeline. Responds 202 with counts; no database call on this path except
// a cached agent-key lookup.
import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { INGEST_MAX_BODY, IngestBatchEnvelopeSchema, SHED_RETRY_AFTER_S, type IngestResponse } from '@epicenter/shared';
import type { PipelineCore } from '../../pipeline/ingest';
import { ingestEvents } from '../../pipeline/ingest';
import type { LoadShedder } from '../../pipeline/loadShed';
import type { TokenBuckets } from '../../pipeline/tokenBucket';
import { HttpError } from '../errors';
import { agentKey, agentsOf, type AgentInfo } from '../middleware/agentKey';

/**
 * One bucket per agent key. The simulator's region agents share SIM_KEY and the batch's agentId is only
 * known after parsing, so the agents behind a key share one bucket sized to their combined rate and burst.
 */
const bucketOf = (agents: AgentInfo[]) => ({
  id: agents.map((a) => a.agentId).sort().join(','),
  rate: agents.reduce((s, a) => s + a.ratePerSec, 0),
  burst: agents.reduce((s, a) => s + a.burst, 0),
});

export function ingestRouter(core: PipelineCore, shedder: LoadShedder, buckets: TokenBuckets): Router {
  const r = Router();

  const tooMany = (retryAfterSec: number, code: string, message: string) => {
    core.counters.add('shed429');
    return Object.assign(new HttpError(429, code, message), { retryAfterSec });
  };

  const shed: RequestHandler = (_req, _res, next) => {
    if (shedder.shouldShed(Date.now())) return next(tooMany(SHED_RETRY_AFTER_S, 'shedding', 'Server is shedding load, retry later'));
    next();
  };

  const bucket: RequestHandler = (_req, res, next) => {
    const b = bucketOf(agentsOf(res));
    const r = buckets.admit(b.id, b.rate, b.burst, Date.now());
    if (!r.ok) return next(tooMany(r.retryAfterSec, 'rate_limited', 'Agent rate limit exceeded'));
    next();
  };

  /** Charges the bucket for what the request actually carried (events, or 1 for a body with none). */
  const charge = (res: express.Response, events: number) => {
    const b = bucketOf(agentsOf(res));
    buckets.charge(b.id, Math.max(1, events), b.rate, b.burst, Date.now());
  };

  r.post('/', agentKey, shed, bucket, express.json({ limit: INGEST_MAX_BODY }), (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.length : 0;
    charge(res, events);
    const env = IngestBatchEnvelopeSchema.safeParse(req.body);
    if (!env.success) {
      core.counters.add('rejected', Math.max(1, events));
      throw env.error;
    }
    const agent = agentsOf(res).find((a) => a.agentId === env.data.agentId);
    if (!agent) {
      core.counters.add('rejected', env.data.events.length);
      throw new HttpError(403, 'agent_mismatch', 'agentId does not match the key');
    }
    const { accepted, duplicate, late, rejected } = ingestEvents(core, env.data.events, agent.nodePrefix, Date.now());
    const body: IngestResponse = { accepted, duplicate, late, rejected };
    res.status(202).json(body);
  });

  // Oversized or unparsable bodies still count as rejected traffic (and cost a token); 429s get Retry-After.
  const finish: ErrorRequestHandler = (err, _req, res, next) => {
    const t = (err as { type?: string })?.type;
    if (t === 'entity.too.large' || t === 'entity.parse.failed') {
      core.counters.add('rejected');
      if (res.locals.agents) charge(res, 1);
    }
    const retry = (err as { retryAfterSec?: number })?.retryAfterSec;
    if (retry !== undefined) res.setHeader('Retry-After', String(retry));
    next(err);
  };
  r.use(finish);
  return r;
}
