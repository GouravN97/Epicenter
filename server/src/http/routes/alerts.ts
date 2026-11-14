// Alerts REST (plan §6.2): GET /alerts (team-scoped, cursor-paginated), POST /alerts/:id/ack (sre, admin).
import { Router } from 'express';
import { AlertsQuerySchema, ObjectIdParamSchema, type AlertDTO } from '@epicenter/shared';
import { AlertModel } from '../../db/models';
import { docToAlert } from '../../pipeline/alertStore';
import type { Detector } from '../../pipeline/detector';
import { visibleTeams } from '../../realtime/rooms';
import { HttpError } from '../errors';
import { auth, currentUser, requireRole } from '../middleware/auth';

/** GET /alerts response. Pass `nextBefore` as `before` to get the next (older) page; null on the last page. */
export interface AlertsPage {
  alerts: AlertDTO[];
  nextBefore: number | null;
}

export function alertsRouter(detector: Detector): Router {
  const r = Router();

  r.get('/', auth, async (req, res) => {
    const q = AlertsQuerySchema.parse(req.query);
    const filter: Record<string, unknown> = { team: { $in: visibleTeams(currentUser(req)) } };
    if (q.state) filter.state = q.state;
    if (q.before !== undefined) filter.startedAt = { $lt: new Date(q.before) };
    let docs = await AlertModel.find(filter).sort({ startedAt: -1, _id: -1 }).limit(q.limit + 1).lean();
    let more = docs.length > q.limit;
    docs = docs.slice(0, q.limit);
    // The cursor is "startedAt < before", so a page must never split alerts that share a startedAt (a
    // fleet-wide heartbeat sweep fires many in the same ms). If it would, include the whole tie group.
    const edge = docs.at(-1)?.startedAt;
    if (more && edge) {
      const ties = await AlertModel.find({ ...filter, startedAt: edge }).sort({ _id: -1 }).lean();
      docs = [...docs.filter((d) => d.startedAt.getTime() !== edge.getTime()), ...ties];
      more = (await AlertModel.exists({ ...filter, startedAt: { $lt: edge } })) !== null;
    }
    const page = docs.map((d) => {
      // In-memory state is fresher than the last persisted write (e.g. current value).
      return detector.getActive(d._id.toString()) ?? docToAlert(d as unknown as Parameters<typeof docToAlert>[0]);
    });
    const body: AlertsPage = { alerts: page, nextBefore: more ? page.at(-1)!.startedAt : null };
    res.json(body);
  });

  r.post('/:id/ack', auth, requireRole('sre', 'admin'), async (req, res) => {
    const { id } = ObjectIdParamSchema.parse(req.params);
    const user = currentUser(req);
    const live = detector.getActive(id);
    if (live) {
      if (!visibleTeams(user).includes(live.team as never)) throw new HttpError(403, 'forbidden', 'Alert belongs to another team');
      // The detector emits an update on a real state change; alertStore persists and broadcasts it.
      res.json(detector.ack(id, user.sub));
      return;
    }
    const doc = await AlertModel.findById(id).lean();
    if (!doc) throw new HttpError(404, 'not_found', 'No such alert');
    const a = docToAlert(doc as unknown as Parameters<typeof docToAlert>[0]);
    if (!visibleTeams(user).includes(a.team as never)) throw new HttpError(403, 'forbidden', 'Alert belongs to another team');
    if (a.state === 'resolved') throw new HttpError(409, 'already_resolved', 'Alert is already resolved');
    res.json(a);
  });

  return r;
}
