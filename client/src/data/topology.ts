// Topology registry: GET /topology is fetched once per session. After that the wire carries integer
// node and service indexes (plan §7.3) and this module maps them back to ids.
import { room, type TopologyNode, type TopologyResponse } from '@epicenter/shared';

export class TopologyRegistry {
  data: TopologyResponse | null = null;
  /** nodeIdx → nodeId. Sparse for a viewer, whose node list is filtered but whose indexes are global. */
  nodeIdByIdx: (string | undefined)[] = [];
  /** nodeIdx → "node:<id>" room key, precomputed so the per-point path does no string building. */
  nodeRoomByIdx: (string | undefined)[] = [];
  nodeByIdx: (TopologyNode | undefined)[] = [];
  idxByNodeId = new Map<string, number>();
  /** One more than the highest nodeIdx. */
  size = 0;

  private loading: Promise<void> | null = null;
  private waiters: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  /** Loads once; concurrent and later calls share the result. A failed load can be retried. */
  load(fetchTopology: () => Promise<TopologyResponse>): Promise<void> {
    this.loading ??= fetchTopology().then(
      (data) => this.set(data),
      (err) => {
        this.loading = null;
        throw err;
      },
    );
    return this.loading;
  }

  /** Resolves once a topology is loaded. */
  ready(): Promise<void> {
    if (this.data) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  set(data: TopologyResponse): void {
    this.data = data;
    this.nodeIdByIdx = [];
    this.nodeRoomByIdx = [];
    this.nodeByIdx = [];
    this.idxByNodeId = new Map();
    let max = -1;
    for (const n of data.nodes) {
      const [idx, nodeId] = n;
      this.nodeIdByIdx[idx] = nodeId;
      this.nodeRoomByIdx[idx] = room.node(nodeId);
      this.nodeByIdx[idx] = n;
      this.idxByNodeId.set(nodeId, idx);
      if (idx > max) max = idx;
    }
    this.size = max + 1;
    for (const w of this.waiters.splice(0)) w();
    this.emit();
  }

  reset(): void {
    this.data = null;
    this.loading = null;
    this.nodeIdByIdx = [];
    this.nodeRoomByIdx = [];
    this.nodeByIdx = [];
    this.idxByNodeId = new Map();
    this.size = 0;
    this.emit();
  }

  // For useSyncExternalStore.
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): TopologyResponse | null => this.data;

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
