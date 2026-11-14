// Latest per-service aggregates from topo:tick (plan §7.3), indexed by svcIdx. Like fleetState, plain
// typed arrays mutated in place; the topology map and the stat tiles read them.
import { SERVICES, TT, type TopoTick } from '@epicenter/shared';
import { Ring } from './ring';

const HISTORY = 60; // one minute of 1 Hz ticks for sparklines

export class TopoState {
  readonly n = SERVICES.length;
  cpuAvg = new Float32Array(this.n);
  latP95 = new Float32Array(this.n);
  errAvg = new Float32Array(this.n);
  rps = new Float32Array(this.n);
  healthy = new Uint16Array(this.n);
  total = new Uint16Array(this.n);
  status = new Uint8Array(this.n);
  tsSec = 0;
  version = 0;

  /** Recent rps and p95 latency per service, for sparklines. */
  readonly rpsHistory = SERVICES.map(() => new Ring(HISTORY));
  readonly latHistory = SERVICES.map(() => new Ring(HISTORY));

  apply(tick: TopoTick): void {
    const tsSec = tick[0];
    if (tsSec <= this.tsSec) return; // an old or repeated tick must not rewind the state or the history
    for (let i = 1; i < tick.length; i++) {
      const row = tick[i] as number[];
      const s = row[TT.svcIdx]!;
      if (!(s >= 0 && s < this.n)) continue;
      this.cpuAvg[s] = row[TT.cpuAvg]!;
      this.latP95[s] = row[TT.latP95]!;
      this.errAvg[s] = row[TT.errAvg]!;
      this.rps[s] = row[TT.rps]!;
      this.healthy[s] = row[TT.healthy]!;
      this.total[s] = row[TT.total]!;
      this.status[s] = row[TT.status]!;
      this.rpsHistory[s]!.push(row[TT.rps]!);
      this.latHistory[s]!.push(row[TT.latP95]!);
    }
    this.tsSec = tsSec;
    this.version++;
  }

  reset(): void {
    for (const a of [this.cpuAvg, this.latP95, this.errAvg, this.rps, this.healthy, this.total, this.status]) a.fill(0);
    for (const r of [...this.rpsHistory, ...this.latHistory]) r.clear();
    this.tsSec = 0;
    this.version++;
  }
}
