// Fixed-capacity time series kept sorted by time (plan §9.2).
//
// `upsert` is the client's whole dedup story: history rows, live points, corrections and reconnect
// gap-fills all go through it, in any order, and a point is identified by its timestamp. Feeding the
// same points twice, shuffled, leaves the buffer identical.
//
// Storage is typed arrays, twice the capacity long, with a sliding [start, start + length) window, so an
// append at capacity is O(1) (no shifting) and the readers below are zero-copy views that a canvas chart
// can use directly.

export class SeriesBuffer {
  readonly capacity: number;
  /** Number of value columns. */
  readonly width: number;
  /** Increments on every change. Lets a renderer skip work when nothing moved. */
  version = 0;

  private readonly t: Float64Array;
  private readonly cols: Float32Array[];
  private readonly rev: Uint32Array;
  private start = 0;
  private len = 0;

  constructor(width: number, capacity = 3600) {
    if (!(capacity >= 1) || !(width >= 1)) throw new RangeError('SeriesBuffer needs capacity ≥ 1 and width ≥ 1');
    this.capacity = capacity;
    this.width = width;
    this.t = new Float64Array(capacity * 2);
    this.cols = Array.from({ length: width }, () => new Float32Array(capacity * 2));
    this.rev = new Uint32Array(capacity * 2);
  }

  get length(): number {
    return this.len;
  }
  /** Oldest timestamp, or NaN when empty. */
  get firstT(): number {
    return this.len ? this.t[this.start]! : NaN;
  }
  /** Newest timestamp, or NaN when empty. */
  get lastT(): number {
    return this.len ? this.t[this.start + this.len - 1]! : NaN;
  }

  /** Zero-copy views of the live window. Valid until the next change; do not hold on to them. */
  times(): Float64Array {
    return this.t.subarray(this.start, this.start + this.len);
  }
  column(i: number): Float32Array {
    return this.cols[i]!.subarray(this.start, this.start + this.len);
  }
  revs(): Uint32Array {
    return this.rev.subarray(this.start, this.start + this.len);
  }

  /** Index of `t` in the window, or −1. */
  indexOf(t: number): number {
    const i = this.search(t);
    return i >= 0 ? i : -1;
  }

  /**
   * Inserts or overwrites the point at time `t`. `values[offset .. offset + width)` are the columns.
   *  - newest point: appended; the oldest is evicted when the buffer is full
   *  - `t` already present: overwritten when `rev` ≥ the stored rev, otherwise ignored (a stale copy)
   *  - older `t` not present: inserted in order (dropped if it is older than a full window)
   * Returns true when the buffer changed.
   */
  upsert(t: number, values: ArrayLike<number>, offset = 0, rev = 0): boolean {
    if (!Number.isFinite(t)) return false;

    if (this.len === 0 || t > this.t[this.start + this.len - 1]!) {
      if (this.len === this.capacity) {
        this.start++;
        this.len--;
      }
      if (this.start + this.len === this.t.length) this.compact();
      this.write(this.start + this.len, t, values, offset, rev);
      this.len++;
      this.version++;
      return true;
    }

    let i = this.search(t);
    if (i >= 0) {
      const at = this.start + i;
      if (rev < this.rev[at]!) return false;
      if (rev === this.rev[at] && this.sameValues(at, values, offset)) return false;
      this.write(at, t, values, offset, rev);
      this.version++;
      return true;
    }

    i = ~i; // insertion index within the window
    if (this.len === this.capacity) {
      if (i === 0) return false; // older than everything in a full window: it would be evicted at once
      this.start++;
      this.len--;
      i--;
    }
    if (this.start + this.len === this.t.length) this.compact();
    const at = this.start + i;
    const end = this.start + this.len;
    this.t.copyWithin(at + 1, at, end);
    this.rev.copyWithin(at + 1, at, end);
    for (const c of this.cols) c.copyWithin(at + 1, at, end);
    this.write(at, t, values, offset, rev);
    this.len++;
    this.version++;
    return true;
  }

  /** Bulk upsert of a columnar history response: `columns[c][i]` is column c at time `t[i]`. */
  upsertColumnar(t: ArrayLike<number>, columns: ArrayLike<number>[], rev?: ArrayLike<number>): boolean {
    const row = new Float64Array(this.width);
    let changed = false;
    for (let i = 0; i < t.length; i++) {
      for (let c = 0; c < this.width; c++) row[c] = columns[c]?.[i] ?? NaN;
      if (this.upsert(t[i]!, row, 0, rev?.[i] ?? 0)) changed = true;
    }
    return changed;
  }

  clear(): void {
    if (this.len) this.version++;
    this.start = 0;
    this.len = 0;
  }

  /** Binary search. Returns the window index, or the bitwise complement of the insertion index. */
  private search(t: number): number {
    let lo = 0;
    let hi = this.len - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.t[this.start + mid]!;
      if (v < t) lo = mid + 1;
      else if (v > t) hi = mid - 1;
      else return mid;
    }
    return ~lo;
  }

  private sameValues(at: number, values: ArrayLike<number>, offset: number): boolean {
    for (let c = 0; c < this.width; c++) {
      const a = this.cols[c]![at]!;
      const b = Math.fround(values[offset + c]!);
      if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return false;
    }
    return true;
  }

  private write(at: number, t: number, values: ArrayLike<number>, offset: number, rev: number): void {
    this.t[at] = t;
    this.rev[at] = rev;
    for (let c = 0; c < this.width; c++) this.cols[c]![at] = values[offset + c]!;
  }

  /** Moves the window back to the front of the backing arrays. */
  private compact(): void {
    const end = this.start + this.len;
    this.t.copyWithin(0, this.start, end);
    this.rev.copyWithin(0, this.start, end);
    for (const c of this.cols) c.copyWithin(0, this.start, end);
    this.start = 0;
  }
}
