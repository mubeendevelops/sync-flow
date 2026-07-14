/**
 * Per-connection token bucket. `express-rate-limit` guards HTTP routes but does not
 * apply to a long-lived socket, so each socket carries its own bucket to cap ops/sec
 * and stop one client from DoS-ing a document with a flood of edits.
 *
 * Tokens refill continuously at `refillPerSec` up to `capacity` (the burst allowance).
 * `tryRemove(n)` succeeds and debits n tokens if enough are available, else fails
 * without debiting — the caller rejects the op batch and keeps the connection open.
 */

export interface TokenBucketOptions {
  /** Max tokens (burst). Default 100. */
  readonly capacity?: number;
  /** Tokens replenished per second (sustained rate). Default 50. */
  readonly refillPerSec?: number;
  /** Injectable clock (ms) for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_CAPACITY = 100;
const DEFAULT_REFILL_PER_SEC = 50;

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.refillPerSec = options.refillPerSec ?? DEFAULT_REFILL_PER_SEC;
    this.now = options.now ?? Date.now;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Try to debit `n` tokens. Returns true (and debits) if available, false otherwise. */
  tryRemove(n: number): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  private refill(): void {
    const now = this.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }
}
