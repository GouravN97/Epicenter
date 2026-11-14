// History API (plan §6.2): /metrics/node/:nodeId, /metrics/service/:serviceId, /replay. Columnar responses.
// All team-scoped: a viewer only reads nodes and services of their own teams.
import { Router } from 'express';
import type { Model } from 'mongoose';
import {
  HISTORY_MAX_POINTS,
  NodeMetricsParamsSchema,
  NodeMetricsQuerySchema,
  REPLAY_MAX_RANGE_MS,
  ReplayQuerySchema,
  SERVICES,
  ServiceMetricsParamsSchema,
  ServiceMetricsQuerySchema,
  teamOfService,
  type NodeSeriesResponse,
  type ReplayResponse,
  type ServiceSeriesResponse,
} from '@epicenter/shared';
import { Metric1mModel, Metric1sModel } from '../../db/models';
import { clampRange, emptySeries, resolveRange, toColumnar, type ConcreteRes, type HistoryRow } from '../../history/columnar';
import type { NodeRegistry } from '../../pipeline/nodeRegistry';
import { visibleTeams } from '../../realtime/rooms';
import { HttpError } from '../errors';
import { auth, currentUser } from '../middleware/auth';

const PROJECTION = { _id: 0, ts: 1, cpu: 1, mem: 1, disk: 1, netIn: 1, netOut: 1, lat: 1, err: 1, rps: 1, rev: 1 } as const;
// The models share one shape; the union of two distinct Model types is not callable, so widen to one.
const modelFor = (res: ConcreteRes) => (res === '1s' ? Metric1sModel : Metric1mModel) as unknown as Model<HistoryRow>;

export function historyRouter(registry: NodeRegistry): Router {
  const r = Router();

  r.get('/metrics/node/:nodeId', auth, async (req, res) => {
    const { nodeId } = NodeMetricsParamsSchema.parse(req.params);
    const q = NodeMetricsQuerySchema.parse(req.query);
    const node = registry.get(nodeId);
    if (!node) throw new HttpError(404, 'unknown_node', `No node ${nodeId}`);
    if (!visibleTeams(currentUser(req)).includes(node.team)) throw new HttpError(403, 'forbidden', 'Node belongs to another team');

    const range = resolveRange(q.from, q.to, q.res);
    const rows = await modelFor(range.res)
      .find({ nodeId, ts: { $gte: new Date(range.from), $lte: new Date(range.to) } }, PROJECTION)
      .sort({ ts: 1 })
      .limit(HISTORY_MAX_POINTS + 1)
      .lean<HistoryRow[]>();
    const body: NodeSeriesResponse = { nodeId, ...toColumnar(rows, range.res) };
    res.json(body);
  });

  r.get('/metrics/service/:serviceId', auth, async (req, res) => {
    const { serviceId } = ServiceMetricsParamsSchema.parse(req.params);
    const q = ServiceMetricsQuerySchema.parse(req.query);
    if (!visibleTeams(currentUser(req)).includes(teamOfService(serviceId))) {
      throw new HttpError(403, 'forbidden', 'Service belongs to another team');
    }
    const range = resolveRange(q.from, q.to, q.res);
    const nodeIds = registry.list.filter((n) => n.serviceId === serviceId).map((n) => n.nodeId);
    // avg cpu/mem/disk/err, sum rps and network, max latency (§6.2), per timestamp.
    const rows = await modelFor(range.res).aggregate<HistoryRow & { _id: Date }>([
      { $match: { nodeId: { $in: nodeIds }, ts: { $gte: new Date(range.from), $lte: new Date(range.to) } } },
      {
        $group: {
          _id: '$ts',
          cpu: { $avg: '$cpu' },
          mem: { $avg: '$mem' },
          disk: { $avg: '$disk' },
          err: { $avg: '$err' },
          rps: { $sum: '$rps' },
          netIn: { $sum: '$netIn' },
          netOut: { $sum: '$netOut' },
          lat: { $max: '$lat' },
          rev: { $max: '$rev' },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: HISTORY_MAX_POINTS },
    ]);
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const body: ServiceSeriesResponse = {
      serviceId,
      ...toColumnar(
        rows.map((x) => ({ ...x, ts: x._id, cpu: r1(x.cpu), mem: r1(x.mem), disk: r1(x.disk), err: r1(x.err), rps: r1(x.rps), netIn: r1(x.netIn), netOut: r1(x.netOut) })),
        range.res,
      ),
    };
    res.json(body);
  });

  r.get('/replay', auth, async (req, res) => {
    const q = ReplayQuerySchema.parse(req.query);
    const teams = visibleTeams(currentUser(req));
    const allowed = SERVICES.filter((s) => teams.includes(s.team)).map((s) => s.id);
    const forbidden = q.services.filter((s) => !allowed.includes(s));
    if (forbidden.length) throw new HttpError(403, 'forbidden', `Not visible: ${forbidden.join(', ')}`);
    const services = new Set(q.services.length ? q.services : allowed);
    const { from, to } = clampRange(q.from, q.to, REPLAY_MAX_RANGE_MS);

    const nodes = registry.list.filter((n) => services.has(n.serviceId));
    const rows = await Metric1sModel.find(
      { nodeId: { $in: nodes.map((n) => n.nodeId) }, ts: { $gte: new Date(from), $lte: new Date(to) } },
      { ...PROJECTION, nodeId: 1 },
    )
      .sort({ nodeId: 1, ts: 1 })
      .lean<(HistoryRow & { nodeId: string })[]>();

    const byNode = new Map<string, HistoryRow[]>();
    for (const row of rows) {
      let list = byNode.get(row.nodeId);
      if (!list) byNode.set(row.nodeId, (list = []));
      list.push(row);
    }
    const body: ReplayResponse = {
      from,
      to,
      nodes: nodes.map((n) => ({ nodeId: n.nodeId, ...(byNode.has(n.nodeId) ? toColumnar(byNode.get(n.nodeId)!, '1s') : emptySeries('1s')) })),
    };
    res.json(body);
  });

  return r;
}
