/**
 * When to snapshot: every 100 ops OR 30s of activity, first to fire (PLAN Decision
 * Log + CLAUDE.md), plus an explicit snapshot on last-client-disconnect (driven by
 * the caller via `DocumentStore.close`, not this policy).
 *
 * Pure bookkeeping — no I/O. The owner records persisted ops and asks `due()`; the
 * 30s timer is measured from the last snapshot, so a quietly-idle document doesn't
 * accrue a snapshot it doesn't need (`due()` also requires ≥1 op since the last).
 */

export interface SnapshotPolicyOptions {
  /** Snapshot after this many persisted ops since the last snapshot. Default 100. */
  readonly everyOps?: number;
  /** Snapshot after this long (ms) since the last snapshot, if any ops occurred. Default 30s. */
  readonly everyMs?: number;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_EVERY_OPS = 100;
const DEFAULT_EVERY_MS = 30_000;

export class SnapshotPolicy {
  private opsSinceSnapshot = 0;
  private lastSnapshotAt: number;

  private readonly everyOps: number;
  private readonly everyMs: number;
  private readonly now: () => number;

  constructor(options: SnapshotPolicyOptions = {}) {
    this.everyOps = options.everyOps ?? DEFAULT_EVERY_OPS;
    this.everyMs = options.everyMs ?? DEFAULT_EVERY_MS;
    this.now = options.now ?? Date.now;
    this.lastSnapshotAt = this.now();
  }

  recordOps(count: number): void {
    this.opsSinceSnapshot += count;
  }

  /** True once enough ops OR enough time has elapsed — and at least one op occurred. */
  due(): boolean {
    if (this.opsSinceSnapshot === 0) return false;
    return (
      this.opsSinceSnapshot >= this.everyOps || this.now() - this.lastSnapshotAt >= this.everyMs
    );
  }

  /** Call after a snapshot is written to restart both counters. */
  reset(): void {
    this.opsSinceSnapshot = 0;
    this.lastSnapshotAt = this.now();
  }
}
