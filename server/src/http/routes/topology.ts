// GET /api/v1/topology (plan §6.2). Static topology plus the node list with server-assigned nodeIdx,
// filtered to the user's teams. Clients use it to decode the integer indexes on the wire.
import { Router } from 'express';
import { EDGES, REGIONS, SERVICES, type TopologyResponse } from '@epicenter/shared';
import type { NodeRegistry } from '../../pipeline/nodeRegistry';
import { visibleTeams } from '../../realtime/rooms';
import { auth, currentUser } from '../middleware/auth';

export function topologyRouter(registry: NodeRegistry): Router {
  const r = Router();
  r.get('/', auth, (req, res) => {
    const teams = visibleTeams(currentUser(req));
    const body: TopologyResponse = {
      services: SERVICES.map((s) => ({
        idx: s.idx,
        id: s.id,
        name: s.name,
        team: s.team,
        sloMs: s.sloMs,
        layer: s.layer,
        dependsOn: s.dependsOn.map((d) => d.service),
      })),
      edges: EDGES.map((e) => ({ ...e })),
      teams,
      regions: REGIONS.map((x) => x.id),
      nodes: registry.list.filter((n) => teams.includes(n.team)).map((n) => [n.idx, n.nodeId, n.serviceId, n.region, n.az]),
    };
    res.json(body);
  });
  return r;
}
