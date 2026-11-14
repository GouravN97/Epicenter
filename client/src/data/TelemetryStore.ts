// Telemetry lives here, outside React (plan §9.2). Components never put points in state: they register a
// draw function, and one requestAnimationFrame loop calls the draw functions of dirty, visible keys at
// most once per frame. Many socket events inside one frame cost one redraw.
import { METRICS, SERIES_BUFFER_CAPACITY } from '@epicenter/shared';
import { SeriesBuffer } from './SeriesBuffer';

export interface Drawer {
  /** Off-screen drawers are skipped; turning visible draws once to catch up. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface DrawerRec {
  key: string;
  fn: () => void;
  visible: boolean;
}

export interface StoreDeps {
  raf?: (cb: () => void) => unknown;
  isHidden?: () => boolean;
}

export class TelemetryStore {
  private readonly entries = new Map<string, { buf: SeriesBuffer; refs: number }>();
  private readonly drawers = new Map<string, Set<DrawerRec>>();
  private readonly dirty = new Set<string>();
  private scheduled = false;
  private readonly raf: (cb: () => void) => unknown;
  private readonly isHidden: () => boolean;

  constructor(deps: StoreDeps = {}) {
    this.raf = deps.raf ?? ((cb) => requestAnimationFrame(cb));
    this.isHidden = deps.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
    if (typeof document !== 'undefined') {
      // Nothing is drawn while the tab is hidden; redraw everything when it comes back.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) for (const key of this.drawers.keys()) this.markDirty(key);
      });
    }
  }

  // ------------------------------------------------------------------ buffers (ref-counted)

  /** Gets or creates the buffer for `key`. Pair every call with `release`. */
  acquire(key: string, width: number = METRICS.length, capacity: number = SERIES_BUFFER_CAPACITY): SeriesBuffer {
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { buf: new SeriesBuffer(width, capacity), refs: 0 }));
    e.refs++;
    return e.buf;
  }

  /** The buffer is dropped when its last user releases it. */
  release(key: string): void {
    const e = this.entries.get(key);
    if (e && --e.refs <= 0) this.entries.delete(key);
  }

  get(key: string): SeriesBuffer | undefined {
    return this.entries.get(key)?.buf;
  }

  /** Upserts one point if anyone holds a buffer for `key`; otherwise the point is dropped. */
  upsert(key: string, t: number, values: ArrayLike<number>, offset = 0, rev = 0): void {
    const e = this.entries.get(key);
    if (e && e.buf.upsert(t, values, offset, rev)) this.markDirty(key);
  }

  // ------------------------------------------------------------------ drawing

  /** Registers a draw function for `key`. Keys need not be buffers ('fleet' is the heatmap's key). */
  addDrawer(key: string, fn: () => void): Drawer {
    const rec: DrawerRec = { key, fn, visible: true };
    let set = this.drawers.get(key);
    if (!set) this.drawers.set(key, (set = new Set()));
    set.add(rec);
    this.markDirty(key);
    return {
      setVisible: (visible) => {
        if (rec.visible === visible) return;
        rec.visible = visible;
        if (visible) this.markDirty(key);
      },
      dispose: () => {
        const s = this.drawers.get(key);
        s?.delete(rec);
        if (s?.size === 0) this.drawers.delete(key);
      },
    };
  }

  markDirty(key: string): void {
    if (!this.drawers.has(key)) return; // nobody draws this key
    this.dirty.add(key);
    if (this.scheduled) return;
    this.scheduled = true;
    this.raf(() => this.flush());
  }

  /** One frame: draw each dirty key once. Public so tests can run a frame by hand. */
  flush(): void {
    this.scheduled = false;
    if (this.isHidden()) return; // keys stay dirty; visibilitychange schedules the catch-up frame
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const set = this.drawers.get(key);
      if (!set) continue;
      for (const rec of set) if (rec.visible) rec.fn();
    }
  }
}
