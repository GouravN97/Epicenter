// The app's single source of "now" (plan §9.2). Components read time from the clock, never Date.now(),
// so the same charts, heatmap and topology can show the live stream or an incident replay.
//
//  - live:   now() = local time + the server offset measured with the socket `time` handshake
//  - replay: now() = a position inside the recording, advancing at `speed` while playing

export type ClockMode = 'live' | 'replay';

export interface ClockSnapshot {
  mode: ClockMode;
  speed: number;
  playing: boolean;
}

export class Clock {
  /** Server time − local time, ms. */
  offsetMs = 0;
  /** Round-trip time of the best `time` sample, ms. */
  rttMs = 0;

  private snap: ClockSnapshot = { mode: 'live', speed: 1, playing: true };
  private anchorT = 0;
  private anchorPerf = 0;
  private readonly listeners = new Set<() => void>();
  private readonly perf: () => number;
  private readonly wall: () => number;

  constructor(deps: { perf?: () => number; wall?: () => number } = {}) {
    this.perf = deps.perf ?? (() => performance.now());
    this.wall = deps.wall ?? Date.now;
  }

  get mode(): ClockMode {
    return this.snap.mode;
  }
  get speed(): number {
    return this.snap.speed;
  }
  get playing(): boolean {
    return this.snap.playing;
  }

  /** Current time in epoch ms, on the server's clock. */
  now(): number {
    if (this.snap.mode === 'live') return this.wall() + this.offsetMs;
    return this.snap.playing ? this.anchorT + (this.perf() - this.anchorPerf) * this.snap.speed : this.anchorT;
  }

  /** Server's current time, whatever the mode. */
  liveNow(): number {
    return this.wall() + this.offsetMs;
  }

  /** Enters replay at `t` (epoch ms), paused unless `playing`. */
  startReplay(t: number, opts: { speed?: number; playing?: boolean } = {}): void {
    this.anchor(t);
    this.update({ mode: 'replay', speed: opts.speed ?? this.snap.speed, playing: opts.playing ?? false });
  }

  /** Jumps to `t` in the recording (scrubber). */
  seek(t: number): void {
    if (this.snap.mode !== 'replay') return;
    this.anchor(t);
    this.emit();
  }

  play(): void {
    if (this.snap.mode !== 'replay' || this.snap.playing) return;
    this.anchor(this.anchorT);
    this.update({ playing: true });
  }

  pause(): void {
    if (this.snap.mode !== 'replay' || !this.snap.playing) return;
    this.anchor(this.now());
    this.update({ playing: false });
  }

  setSpeed(speed: number): void {
    if (this.snap.mode === 'replay') this.anchor(this.now()); // keep the position, change the rate
    this.update({ speed });
  }

  goLive(): void {
    this.update({ mode: 'live', speed: 1, playing: true });
  }

  /** Feeds one `time` handshake sample: `t0` sent, `ts` server time, `t1` received (all local ms except ts). */
  addTimeSample(t0: number, ts: number, t1: number): void {
    const rtt = t1 - t0;
    if (rtt < 0) return;
    // Keep the sample with the shortest round trip: it bounds the error best.
    if (this.rttMs === 0 || rtt <= this.rttMs) {
      this.rttMs = rtt;
      this.offsetMs = ts + rtt / 2 - t1;
    }
  }

  resetSync(): void {
    this.offsetMs = 0;
    this.rttMs = 0;
  }

  // For useSyncExternalStore: the snapshot object is replaced only when mode, speed or playing change.
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ClockSnapshot => this.snap;

  private anchor(t: number): void {
    this.anchorT = t;
    this.anchorPerf = this.perf();
  }
  private update(patch: Partial<ClockSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }
  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
