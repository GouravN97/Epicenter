// Background persistence for the node registry, off the ingest path: inserts nodes first seen at runtime
// and advances `lastSeen` for nodes that reported. One bulkWrite every interval.
import type { NodeRegistry } from '../pipeline/nodeRegistry';
import type { StateStore } from '../pipeline/stateStore';
import { NodeModel } from './models';

export function startNodeSync(registry: NodeRegistry, state: StateStore, intervalMs = 10_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const fresh = registry.takePending();
      const touched = state.takeTouched();
      const ops = [
        ...fresh.map((n) => ({
          updateOne: {
            filter: { nodeId: n.nodeId },
            update: {
              $setOnInsert: { serviceId: n.serviceId, team: n.team, region: n.region, az: n.az, firstSeen: new Date() },
            },
            upsert: true,
          },
        })),
        ...[...touched].flatMap((id) => {
          const s = state.nodes.get(id);
          return s ? [{ updateOne: { filter: { nodeId: id }, update: { $max: { lastSeen: new Date(s.lastSeen) } } } }] : [];
        }),
      ];
      if (ops.length) await NodeModel.bulkWrite(ops, { ordered: false });
    } catch (err) {
      console.error('[nodeSync]', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
