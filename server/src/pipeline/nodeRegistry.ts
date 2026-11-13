// In-memory node registry. Assigns the global, server-side nodeIdx used on the wire (A1 decision): the
// seeded fleet first in buildFleet() order, then dynamically registered nodes (e.g. stress-test nodes) in
// arrival order. Lookups on the ingest path never touch the database; new nodes are queued for persistence.
import { buildFleet, isServiceId, parseNodeId, teamOfService, type ServiceId, type Team } from '@epicenter/shared';

export interface NodeInfo {
  idx: number;
  nodeId: string;
  serviceId: ServiceId;
  team: Team;
  region: string;
  az: string;
}

export class NodeRegistry {
  readonly list: NodeInfo[] = [];
  private readonly byId = new Map<string, NodeInfo>();
  /** Registered at runtime and not yet persisted. */
  private pending: NodeInfo[] = [];

  constructor(seed: { nodeId: string }[] = buildFleet()) {
    for (const n of seed) this.register(n.nodeId, false);
  }

  get(nodeId: string): NodeInfo | undefined {
    return this.byId.get(nodeId);
  }

  /**
   * Known node, or a newly registered one if the id is canonical and names a real service.
   * Returns null for ids that cannot be placed in the topology.
   */
  resolve(nodeId: string): NodeInfo | null {
    return this.byId.get(nodeId) ?? this.register(nodeId, true);
  }

  private register(nodeId: string, persist: boolean): NodeInfo | null {
    const p = parseNodeId(nodeId);
    if (!p || !isServiceId(p.serviceId)) return null;
    const info: NodeInfo = {
      idx: this.list.length,
      nodeId,
      serviceId: p.serviceId,
      team: teamOfService(p.serviceId),
      region: p.region,
      az: p.az,
    };
    this.list.push(info);
    this.byId.set(nodeId, info);
    if (persist) this.pending.push(info);
    return info;
  }

  /** New nodes since the last call (for a background upsert into `nodes`). */
  takePending(): NodeInfo[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
