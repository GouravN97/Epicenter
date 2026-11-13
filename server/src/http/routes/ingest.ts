// POST /api/v1/ingest (plan §6.1, §8.1). Order: agent key → (A10: load shed, token bucket) → 256 kB JSON
// body → envelope validation → per-event pipeline. Responds 202 with counts; no database call on this path
// except a cached agent-key lookup.
import express, { Router, type ErrorRequestHandler } from 'express';
import { INGEST_MAX_BODY, IngestBatchEnvelopeSchema, type IngestResponse } from '@epicenter/shared';
import type { PipelineCore } from '../../pipeline/ingest';
import { ingestEvents } from '../../pipeline/ingest';
import { HttpError } from '../errors';
import { agentKey, agentsOf } from '../middleware/agentKey';

export function ingestRouter(core: PipelineCore): Router {
  const r = Router();

  r.post('/', agentKey, express.json({ limit: INGEST_MAX_BODY }), (req, res) => {
    const env = IngestBatchEnvelopeSchema.safeParse(req.body);
    if (!env.success) {
      core.counters.add('rejected', Array.isArray(req.body?.events) ? Math.max(1, req.body.events.length) : 1);
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

  // Oversized or unparsable bodies still count as rejected traffic before the app's error handler runs.
  const countParseErrors: ErrorRequestHandler = (err, _req, _res, next) => {
    const t = (err as { type?: string })?.type;
    if (t === 'entity.too.large' || t === 'entity.parse.failed') core.counters.add('rejected');
    next(err);
  };
  r.use(countParseErrors);
  return r;
}
