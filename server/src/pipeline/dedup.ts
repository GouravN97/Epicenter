// Sliding-window event dedup (plan §8.1). Event identity is nodeId:bootId:seq.
import { DEDUP_PRUNE_EVERY, DEDUP_WINDOW } from '@epicenter/shared';

export type DedupResult = 'accepted' | 'accepted-out-of-order' | 'duplicate' | 'stale';

interface BootState {
  bootId: string;
  maxSeq: number;
  seen: Set<number>;
  inserts: number;
}

interface NodeState {
  cur: BootState;
  /** The previous boot, so stragglers from before an agent restart are still deduped instead of resetting. */
  prev: BootState | null;
}

const newBoot = (bootId: string, seq: number): BootState => ({ bootId, maxSeq: seq, seen: new Set([seq]), inserts: 1 });

export class Dedup {
  private readonly nodes = new Map<string, NodeState>();

  constructor(
    private readonly window = DEDUP_WINDOW,
    private readonly pruneEvery = DEDUP_PRUNE_EVERY,
  ) {}

  check(e: { nodeId: string; bootId: string; seq: number }): DedupResult {
    const s = this.nodes.get(e.nodeId);
    if (!s) {
      this.nodes.set(e.nodeId, { cur: newBoot(e.bootId, e.seq), prev: null });
      return 'accepted';
    }
    let b: BootState;
    if (s.cur.bootId === e.bootId) b = s.cur;
    else if (s.prev?.bootId === e.bootId) b = s.prev;
    else {
      // New boot: the agent restarted and seq starts again.
      s.prev = s.cur;
      s.cur = newBoot(e.bootId, e.seq);
      return 'accepted';
    }

    if (e.seq <= b.maxSeq - this.window) return 'stale';
    if (b.seen.has(e.seq)) return 'duplicate';
    b.seen.add(e.seq);
    const outOfOrder = e.seq < b.maxSeq;
    if (e.seq > b.maxSeq) b.maxSeq = e.seq;
    if (++b.inserts % this.pruneEvery === 0) {
      const floor = b.maxSeq - this.window;
      for (const q of b.seen) if (q <= floor) b.seen.delete(q);
    }
    return outOfOrder ? 'accepted-out-of-order' : 'accepted';
  }

  /** Seqs currently remembered for a node's current boot (tests, stats). */
  windowSize(nodeId: string): number {
    return this.nodes.get(nodeId)?.cur.seen.size ?? 0;
  }

  forget(nodeId: string): void {
    this.nodes.delete(nodeId);
  }
}
