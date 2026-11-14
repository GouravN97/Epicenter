/** Fixed-size ring of recent numbers: sparkline history and rolling percentiles. */
export class Ring {
  private readonly buf: Float64Array;
  private head = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  push(x: number): void {
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
  }

  /** Oldest → newest. */
  toArray(): number[] {
    const out = new Array<number>(this.len);
    const first = (this.head - this.len + this.capacity) % this.capacity;
    for (let i = 0; i < this.len; i++) out[i] = this.buf[(first + i) % this.capacity]!;
    return out;
  }

  last(): number {
    return this.len ? this.buf[(this.head - 1 + this.capacity) % this.capacity]! : NaN;
  }

  /** q in 0–1 (nearest rank). NaN when empty. */
  quantile(q: number): number {
    if (!this.len) return NaN;
    const sorted = this.toArray().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }
}
