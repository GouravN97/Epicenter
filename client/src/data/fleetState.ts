// Latest state of every node for the fleet heatmap (plan §9.2): typed-array columns indexed by nodeIdx,
// mutated in place by fleet:delta. The heatmap canvas reads them in its draw; nothing here is React state.
import { FD, NodeStatus, type FleetDelta } from '@epicenter/shared';

export class FleetState {
  cpu = new Uint8Array(0);
  mem = new Uint8Array(0);
  status = new Uint8Array(0);
  /** 1 once a node has been seen in a delta; 0 = no data yet. */
  seen = new Uint8Array(0);
  /** Second of the newest delta applied. */
  tsSec = 0;
  /** Increments on every applied delta. */
  version = 0;

  get size(): number {
    return this.cpu.length;
  }

  /** Grows the columns to hold indexes < n, keeping existing values. */
  resize(n: number): void {
    if (n <= this.cpu.length) return;
    const grow = (a: Uint8Array) => {
      const b = new Uint8Array(n);
      b.set(a);
      return b;
    };
    this.cpu = grow(this.cpu);
    this.mem = grow(this.mem);
    this.status = grow(this.status);
    this.seen = grow(this.seen);
  }

  /** Applies `[tsSec, [nodeIdx, cpu, mem, status], …]`. Returns the number of nodes changed. */
  apply(delta: FleetDelta): number {
    const tsSec = delta[0];
    let maxIdx = -1;
    for (let i = 1; i < delta.length; i++) maxIdx = Math.max(maxIdx, (delta[i] as number[])[FD.nodeIdx]!);
    if (maxIdx >= this.cpu.length) this.resize(maxIdx + 1); // a node registered after the topology was fetched

    for (let i = 1; i < delta.length; i++) {
      const row = delta[i] as number[];
      const idx = row[FD.nodeIdx]!;
      if (!(idx >= 0)) continue;
      this.cpu[idx] = row[FD.cpu]!;
      this.mem[idx] = row[FD.mem]!;
      this.status[idx] = row[FD.status]!;
      this.seen[idx] = 1;
    }
    if (tsSec > this.tsSec) this.tsSec = tsSec;
    this.version++;
    return delta.length - 1;
  }

  /** Counts of seen nodes by status: [ok, warn, crit, silent]. */
  statusCounts(): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < this.status.length; i++) {
      if (this.seen[i]) out[Math.min(this.status[i]!, NodeStatus.silent) as 0 | 1 | 2 | 3]++;
    }
    return out;
  }

  reset(): void {
    this.cpu = new Uint8Array(0);
    this.mem = new Uint8Array(0);
    this.status = new Uint8Array(0);
    this.seen = new Uint8Array(0);
    this.tsSec = 0;
    this.version++;
  }
}
