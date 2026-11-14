// Chaos REST (plan §6.3). Admin only.
import { Router } from 'express';
import { z } from 'zod';
import { CHAOS_SCENARIOS, ChaosStartBodySchema } from '@epicenter/shared';
import type { ChaosService } from '../../chaos/chaosService';
import { auth, currentUser, requireRole } from '../middleware/auth';

const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export function chaosRouter(chaos: ChaosService): Router {
  const r = Router();
  r.use(auth, requireRole('admin'));

  r.get('/scenarios', (_req, res) => {
    res.json({ scenarios: CHAOS_SCENARIOS });
  });

  /** Active runs plus recent history (for the Chaos Lab's active list and scorecard history). */
  r.get('/runs', async (req, res) => {
    const { limit } = RunsQuery.parse(req.query);
    res.json({ active: chaos.snapshot(), runs: await chaos.recent(limit) });
  });

  r.post('/start', async (req, res) => {
    const body = ChaosStartBodySchema.parse(req.body);
    res.status(201).json(await chaos.start(body, currentUser(req).sub));
  });

  r.post('/stop', async (_req, res) => {
    res.json({ stopped: await chaos.stopAll() });
  });

  return r;
}
