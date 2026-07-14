/**
 * Batched, debounced writer for the op log. This is the "I do not want 60 INSERTs
 * per second" answer.
 *
 * DURABILITY MODEL (chosen: optimistic ack + micro-batch, ≤250ms / 50 ops window):
 *   Ops are applied to the in-memory CRDT and fanned out over Redis by the caller
 *   BEFORE they are durably persisted; `enqueue` just buffers and returns. The
 *   buffer flushes on whichever comes first: 50 buffered ops or 250ms since the
 *   first buffered op. A 60-keystroke second collapses to ~4 multi-row INSERTs
 *   instead of 60.
 *
 *   TRADEOFF: on a HARD crash (SIGKILL / power loss) up to one flush window of ops
 *   that were acked but not yet flushed is lost from Postgres. This is bounded and
 *   self-healing in practice: connected peers already received those ops via Redis,
 *   and a reconnecting client replays them from its own local buffer (reconnect-
 *   and-resync). A GRACEFUL shutdown loses nothing — `close()` drains the buffer —
 *   so the window only applies to crashes, not deploys/restarts.
 *
 *   Each flush is ONE multi-row INSERT = statement-level atomicity, so a failed
 *   flush is retried whole with no partial-write risk. A retry after a
 *   succeeded-but-unacked INSERT can double-insert rows; that's harmless because
 *   op replay is idempotent (duplicate insert/delete = no-op) — extra rows, same
 *   converged state.
 */

import type { PendingOp, PersistedOp } from "./op-log.repo.js";
import type { Op } from "@sync-flow/crdt";

export type PersistFn = (batch: PendingOp[]) => Promise<PersistedOp[]>;

export interface OpWriterOptions {
  /** Flush once this many ops are buffered. Default 50. */
  readonly maxBatch?: number;
  /** Flush at most this long after the first op in a batch was buffered. Default 250ms. */
  readonly maxDelayMs?: number;
  /** Called after each successful flush with the persisted ops (e.g. to drive snapshots). */
  readonly onPersisted?: (persisted: PersistedOp[]) => void;
  /** Called when a batch could not be persisted even after a retry — a data-loss event. */
  readonly onError?: (err: unknown, dropped: PendingOp[]) => void;
}

const DEFAULT_MAX_BATCH = 50;
const DEFAULT_MAX_DELAY_MS = 250;

export class OpWriter {
  private buffer: PendingOp[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes flushes so batches persist in order and never overlap. */
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;

  private readonly maxBatch: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly persist: PersistFn,
    private readonly options: OpWriterOptions = {},
  ) {
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /** Buffer an op for eventual durable write. Returns immediately (optimistic). */
  enqueue(op: Op, userId: string | null): void {
    if (this.closed) throw new Error("OpWriter is closed");
    this.buffer.push({ op, userId });
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.maxDelayMs);
    }
  }

  /** Number of ops buffered but not yet handed to a flush. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Flush the current buffer now. Safe to call concurrently — calls are chained,
   * so a timer-triggered flush and a manual flush can't interleave a batch.
   */
  flush(): Promise<void> {
    const run = this.flushChain.then(() => this.doFlush());
    // Keep the chain alive even if a flush rejects, so later flushes still run.
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Drain and stop. Flushes any buffered ops so a graceful shutdown loses nothing,
   * then rejects further enqueues. Idempotent.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.flushChain;
  }

  private async doFlush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    let persisted: PersistedOp[];
    try {
      persisted = await this.persist(batch);
    } catch {
      try {
        // One retry. The batch is one atomic INSERT, so the first attempt wrote
        // all-or-nothing; a retry is safe (idempotent at worst — see file header).
        persisted = await this.persist(batch);
      } catch (retryErr) {
        this.options.onError?.(retryErr, batch);
        return;
      }
    }
    this.options.onPersisted?.(persisted);
  }
}
