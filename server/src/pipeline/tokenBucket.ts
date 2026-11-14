// Per-agent token bucket (plan §8.1 step 3): capacity `burst`, refilled at `ratePerSec`, cost = events.
//
// The event count is only known after the body is parsed, and the plan puts the bucket before parsing (so
// a flooding agent does not even get its body parsed). So: admit() before parsing needs at least one token;
// charge() after parsing takes the real cost and may leave the bucket in debt, which later requests wait out.
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  private refill(id: string, rate: number, burst: number, now: number) {
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: burst, at: now };
      this.buckets.set(id, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    return b;
  }

  /** Whether a request may proceed. When not, how long until one token is available (seconds, ≥ 1). */
  admit(id: string, rate: number, burst: number, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const b = this.refill(id, rate, burst, now);
    if (b.tokens >= 1) return { ok: true };
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rate)) };
  }

  /** Takes `cost` tokens (may go negative). */
  charge(id: string, cost: number, rate: number, burst: number, now: number): void {
    this.refill(id, rate, burst, now).tokens -= cost;
  }

  tokens(id: string): number | undefined {
    return this.buckets.get(id)?.tokens;
  }
}
