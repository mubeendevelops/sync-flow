/**
 * Per-document persistence facade: the object a doc-room (task 2.6) holds for the
 * life of an open document. It owns the hydrated in-memory CRDT, the batched op
 * writer, and the snapshot policy, and wires them together:
 *
 *   load()      → hydrate from cache/snapshot + replay tail.
 *   persist(op) → buffer the op for a batched durable write (optimistic; the caller
 *                 has already applied it to `doc` and fanned it out over Redis).
 *   close()     → drain the writer and force a final snapshot (last-client-disconnect).
 *
 * The snapshot watermark only ever advances to a PERSISTED seq (fed from the
 * writer's `onPersisted`). The in-memory `doc` may hold ops that are applied but
 * not yet flushed; snapshotting the live doc while labelling it with the last
 * persisted seq is still correct — on recovery, replay(ops WHERE seq > watermark)
 * re-applies any of those that did persist, and CRDT idempotency makes that a
 * no-op. (It also means an op that made it into a snapshot survives a crash even if
 * its own op-log row didn't — a durability bonus, never a hazard.)
 */

import { RGADocument, applyRemote, type DocumentIdentity, type Op } from "@sync-flow/crdt";
import type { DbClient } from "../db/types.js";
import { hydrateDocument } from "./hydrate.js";
import { appendOperations, type PersistedOp } from "./op-log.repo.js";
import { writeSnapshot } from "./snapshot.repo.js";
import { writeCachedState, type CrdtStateCache } from "./cache.js";
import { OpWriter, type OpWriterOptions } from "./op-writer.js";
import { SnapshotPolicy, type SnapshotPolicyOptions } from "./snapshot-policy.js";

export interface DocumentStoreLogger {
  error(obj: unknown, msg?: string): void;
}

export interface DocumentStoreDeps {
  readonly db: DbClient;
  readonly cache: CrdtStateCache;
  readonly documentId: string;
  readonly identity: DocumentIdentity;
  readonly writer?: Pick<OpWriterOptions, "maxBatch" | "maxDelayMs">;
  readonly policy?: SnapshotPolicyOptions;
  readonly logger?: DocumentStoreLogger;
}

export class DocumentStore {
  readonly doc: RGADocument;
  readonly documentId: string;

  private latestSeq: number;
  private readonly writer: OpWriter;
  private readonly policy: SnapshotPolicy;
  private readonly deps: DocumentStoreDeps;
  /** Serializes snapshot writes so they never overlap or race the watermark. */
  private snapshotting: Promise<void> = Promise.resolve();

  private constructor(deps: DocumentStoreDeps, doc: RGADocument, seq: number) {
    this.deps = deps;
    this.doc = doc;
    this.documentId = deps.documentId;
    this.latestSeq = seq;
    this.policy = new SnapshotPolicy(deps.policy);
    this.writer = new OpWriter((batch) => appendOperations(deps.db, deps.documentId, batch), {
      ...deps.writer,
      onPersisted: (persisted) => this.onPersisted(persisted),
      onError: (err, dropped) =>
        deps.logger?.error(
          { err, documentId: deps.documentId, dropped: dropped.length },
          "op batch persist failed — ops lost from the durable log",
        ),
    });
  }

  /**
   * Highest PERSISTED op version folded into this document — the watermark a client
   * resumes from. Advances only via `onPersisted`, so it's a monotonic lower bound of
   * what's durable (ops applied to `doc` but not yet flushed aren't counted). A client
   * that resyncs from a slightly stale watermark just over-replays, which is a no-op.
   */
  get currentSeq(): number {
    return this.latestSeq;
  }

  static async load(deps: DocumentStoreDeps): Promise<DocumentStore> {
    const { doc, seq } = await hydrateDocument(
      { db: deps.db, cache: deps.cache },
      deps.documentId,
      deps.identity,
    );
    return new DocumentStore(deps, doc, seq);
  }

  /**
   * Persist an op that has ALREADY been applied to `this.doc` by the caller.
   * Returns immediately; the durable write is batched (see `OpWriter`).
   */
  persist(op: Op, userId: string | null): void {
    this.writer.enqueue(op, userId);
  }

  /**
   * Fold ops already applied+persisted by ANOTHER server instance into this
   * instance's in-memory copy (see `sockets/peer-relay.ts`). Never re-persisted —
   * the origin instance already wrote the durable row — and never advances
   * `latestSeq` (only THIS instance's own persisted ops do that; a peer op's seq
   * belongs to the origin's watermark, not ours). A snapshot taken here may embed
   * peer chars under a watermark lower than what actually produced them, but that's
   * safe: replay-on-load re-applies ops with `seq > watermark`, and CRDT idempotency
   * makes re-applying an already-embedded op a no-op.
   */
  applyPeerOps(ops: readonly Op[]): void {
    for (const op of ops) applyRemote(this.doc, op);
  }

  private onPersisted(persisted: PersistedOp[]): void {
    for (const p of persisted) {
      if (p.seq > this.latestSeq) this.latestSeq = p.seq;
    }
    this.policy.recordOps(persisted.length);
    if (this.policy.due()) this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    // Reset synchronously so a burst of onPersisted callbacks queues exactly one
    // snapshot, not one per callback.
    this.policy.reset();
    const seq = this.latestSeq;
    this.snapshotting = this.snapshotting
      .then(() => this.doSnapshot(seq))
      .catch((err) => {
        this.deps.logger?.error({ err, documentId: this.documentId }, "snapshot write failed");
      });
  }

  private async doSnapshot(seq: number): Promise<void> {
    const state = this.doc.toSnapshot();
    await writeSnapshot(this.deps.db, this.documentId, seq, state, this.doc.text());
    await writeCachedState(this.deps.cache, this.documentId, seq, state);
  }

  /** Flush buffered ops and wait for any in-flight snapshot. Does not close. */
  async flush(): Promise<void> {
    await this.writer.flush();
    await this.snapshotting;
  }

  /**
   * Last client left: drain the writer (nothing buffered is lost on a graceful
   * shutdown), let any due snapshot finish, then force a final snapshot at the
   * current watermark so the next load starts from an up-to-date row.
   */
  async close(): Promise<void> {
    await this.writer.close();
    await this.snapshotting;
    await this.doSnapshot(this.latestSeq);
  }
}
