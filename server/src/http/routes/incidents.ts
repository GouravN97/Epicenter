// Incidents REST (plan §6.2): GET /incidents, GET /incidents/:id, POST /incidents/:id/notes (sre, admin).
import { Router } from 'express';
import { z } from 'zod';
import { ALERTS_PAGE_DEFAULT, ALERTS_PAGE_MAX, IncidentNoteBodySchema, ObjectIdParamSchema, type TimelineEntry } from '@epicenter/shared';
import type { IncidentService } from '../../incidents/incidentService';
import { auth, currentUser, requireRole } from '../middleware/auth';

const ListQuery = z.object({
  state: z.enum(['open', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(ALERTS_PAGE_MAX).default(ALERTS_PAGE_DEFAULT),
  before: z.coerce.number().int().nonnegative().optional(),
});

export function incidentsRouter(incidents: IncidentService, onNote: (incidentId: string, e: TimelineEntry) => void): Router {
  const r = Router();

  r.get('/', auth, async (req, res) => {
    res.json(await incidents.list(currentUser(req), ListQuery.parse(req.query)));
  });

  r.get('/:id', auth, async (req, res) => {
    const { id } = ObjectIdParamSchema.parse(req.params);
    res.json(await incidents.detail(currentUser(req), id));
  });

  r.post('/:id/notes', auth, requireRole('sre', 'admin'), async (req, res) => {
    const { id } = ObjectIdParamSchema.parse(req.params);
    const { text } = IncidentNoteBodySchema.parse(req.body);
    const entry = await incidents.addNote(currentUser(req), id, text);
    onNote(id, entry);
    res.status(201).json(entry);
  });

  return r;
}
