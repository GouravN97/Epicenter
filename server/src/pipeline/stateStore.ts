// Latest known state per node (plan §8.1 step 5, §8.5). Raw last-seen data is touched on every accepted
// event; the latest finalized point arrives from the aggregator. The broadcaster (A5) diffs this against
// what it last sent, and the heartbeat rule (A7) reads lastSeen.
import type { MetricValues, TelemetryEvent } from '@epicenter/shared';
import type { Point } from './aggregator';

export interface NodeState {
  nodeId: string;
  /** Server receive time of the last accepted event, epoch ms. */
  lastSeen: number;
  /** Source timestamp of the newest event. */
  lastTs: number;
  /** Newest raw metrics. */
  last: MetricValues | null;
  /** Latest finalized 1 s point (corrections included). */
  point: Point | null;
}

export class StateStore {
  readonly nodes = new Map<string, NodeState>();
  /** Nodes touched since the last takeTouched() (background lastSeen persistence). */
  private touched = new Set<string>();

  private ensure(nodeId: string): NodeState {
    let s = this.nodes.get(nodeId);
    if (!s) {
      s = { nodeId, lastSeen: 0, lastTs: 0, last: null, point: null };
      this.nodes.set(nodeId, s);
    }
    return s;
  }

  touch(e: TelemetryEvent, now: number): void {
    const s = this.ensure(e.nodeId);
    s.lastSeen = now;
    if (e.ts >= s.lastTs) {
      s.lastTs = e.ts;
      s.last = e.m;
    }
    this.touched.add(e.nodeId);
  }

  onPoint(p: Point): void {
    const s = this.ensure(p.nodeId);
    if (!s.point || p.ts >= s.point.ts) s.point = p;
  }

  takeTouched(): Set<string> {
    const out = this.touched;
    this.touched = new Set();
    return out;
  }
}
