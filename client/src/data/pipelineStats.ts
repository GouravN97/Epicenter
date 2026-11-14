// Pipeline stats (meta:pt, plan §8.8) as chart columns, plus this browser's own measurements.
import type { PipelineStats } from '@epicenter/shared';

/** Column order of the `meta` buffer the Pipeline page charts from. */
export const META_COLS = [
  'eps',
  'accepted',
  'duplicate',
  'refused', // rejected + shed429: events turned away at the door
  'loopLagP99',
  'clientE2eP95',
  'localDelayP95',
  'writeMs',
] as const;
export type MetaCol = (typeof META_COLS)[number];
export const metaCol = (c: MetaCol): number => META_COLS.indexOf(c);

/** One buffer row for a stats sample. `localDelayP95` is this browser's own data delay at that moment. */
export function metaRow(s: PipelineStats, localDelayP95: number): number[] {
  // clientE2eP95 is 0 until a dashboard has reported: chart that as "no data", not as zero delay.
  return [s.eps, s.accepted, s.duplicate, s.rejected + s.shed429, s.loopLagP99, s.clientE2eP95 || NaN, localDelayP95, s.writeMs];
}

/**
 * Frames per second, counted on requestAnimationFrame over the last few seconds. rAF does not run in a
 * background tab, so a hidden tab reports nothing rather than a misleading low number.
 */
export class FpsMeter {
  private frames: number[] = [];
  private raf = 0;

  start(): void {
    if (this.raf || typeof requestAnimationFrame === 'undefined') return;
    const loop = (t: number) => {
      this.frames.push(t);
      while (this.frames.length && t - this.frames[0]! > 5000) this.frames.shift();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Frames per second over the window, or null with too little data. */
  read(): number | null {
    const f = this.frames;
    if (f.length < 10) return null;
    const span = f[f.length - 1]! - f[0]!;
    if (span < 1000 || performance.now() - f[f.length - 1]! > 1000) return null;
    return Math.round(((f.length - 1) * 1000) / span);
  }
}
