/**
 * One `DocumentStore` per open document, shared by every socket in that document's
 * room and reference-counted by join/leave. `DocumentStore` owns the materialized
 * CRDT + batched persistence + snapshot policy and is NOT socket-aware, so this is
 * the piece that maps "N sockets in a room" onto "one hydrated store".
 *
 *   acquire(docId) → load-once (deduped across concurrent first-joins), refs++
 *   release(docId) → refs--; at zero, evict + `store.close()` (drain + final snapshot)
 *
 * The server runs the CRDT purely to apply/relay client ops — it never mints ops
 * itself — so the store's `identity` is a fixed server identity that never affects
 * convergence.
 */

import type { DocumentIdentity, Op } from "@sync-flow/crdt";
import type { DbClient } from "../db/types.js";
import {
  DocumentStore,
  type CrdtStateCache,
  type DocumentStoreLogger,
} from "../crdt-service/index.js";

export interface RoomManagerDeps {
  readonly db: DbClient;
  readonly cache: CrdtStateCache;
  readonly logger?: DocumentStoreLogger;
}

interface Room {
  refs: number;
  readonly loading: Promise<DocumentStore>;
}

function serverIdentity(documentId: string): DocumentIdentity {
  // The server applies remote ops but never mints its own, so this identity is never
  // used to create char ids — any stable value is fine.
  return { replicaId: `server:${documentId}`, authorId: "server" };
}

export class DocumentRoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly deps: RoomManagerDeps) {}

  /** Join a room: load the store on first join (deduped), otherwise reuse it. */
  acquire(documentId: string): Promise<DocumentStore> {
    const existing = this.rooms.get(documentId);
    if (existing) {
      existing.refs += 1;
      return existing.loading;
    }

    const loading = DocumentStore.load({
      db: this.deps.db,
      cache: this.deps.cache,
      documentId,
      identity: serverIdentity(documentId),
      logger: this.deps.logger,
    });

    // If the initial load fails, evict so the next join retries from scratch.
    loading.catch(() => {
      const room = this.rooms.get(documentId);
      if (room && room.loading === loading) this.rooms.delete(documentId);
    });

    this.rooms.set(documentId, { refs: 1, loading });
    return loading;
  }

  /** Leave a room: at zero refs, evict immediately and close the store in the background. */
  release(documentId: string): void {
    const room = this.rooms.get(documentId);
    if (!room) return;
    room.refs -= 1;
    if (room.refs > 0) return;

    // Evict before the async close so a concurrent re-join gets a fresh store rather
    // than one that is draining/closing.
    this.rooms.delete(documentId);
    void room.loading
      .then((store) => store.close())
      .catch((err) => this.deps.logger?.error({ err, documentId }, "store close failed"));
  }

  /**
   * Fold ops applied+persisted by a PEER instance into this document's store, if
   * it's open locally — a no-op if this instance has no local socket in that room
   * (nothing to keep convergent; the next local join rehydrates fresh from Postgres).
   */
  applyPeerOps(documentId: string, ops: readonly Op[]): void {
    const room = this.rooms.get(documentId);
    if (!room) return;
    void room.loading
      .then((store) => store.applyPeerOps(ops))
      .catch(() => {
        // The load already failed and was reported/evicted by `acquire`'s own catch —
        // nothing further to do with a peer op for a store that never came up.
      });
  }

  /** Number of currently-open documents (for tests/observability). */
  get openCount(): number {
    return this.rooms.size;
  }

  /** Drain and close every open store — called on graceful shutdown. */
  async closeAll(): Promise<void> {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(
      rooms.map((room) =>
        room.loading
          .then((store) => store.close())
          .catch((err) => this.deps.logger?.error({ err }, "store close failed during shutdown")),
      ),
    );
  }
}
