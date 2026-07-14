/**
 * Version restore — the server-side orchestration around the pure CRDT primitive
 * `reconcileToText` (see `packages/crdt/src/reconcile.ts`).
 *
 * RESTORE IS NOT A DESTRUCTIVE OVERWRITE. It reconstructs the target version's text,
 * diffs the CURRENT live document against it, and emits that diff as ordinary forward
 * RGA ops (inserts + tombstone deletes) which flow through the exact same apply →
 * persist → broadcast path as a user's keystrokes. Consequences:
 *   (a) history stays append-only — only new-seq ops are appended, nothing is rewritten;
 *   (b) the restore is itself undoable — restoring back to the pre-restore version is
 *       just another forward diff (and we snapshot a labelled restore point first);
 *   (c) live clients converge normally — they integrate the ops like any edit, and an
 *       edit made *concurrently* with the restore survives and merges (RGA convergence).
 *
 * Because `reconcileToText` does all its work synchronously (no await between reading
 * the doc and applying the diff), the diff is computed and applied atomically against
 * a consistent snapshot of the live doc — a concurrent socket `edit` handler cannot
 * interleave with it. Concurrent edits are simply integrated before (already in the
 * target reconciliation) or after (via the normal `edit` path), and every replica ends
 * at "restored text + whatever was typed concurrently".
 */

import { randomUUID } from "node:crypto";
import {
  RGADocument,
  applyRemote,
  reconcileToText,
  type DocumentIdentity,
  type DocumentSnapshot,
  type Op,
} from "@sync-flow/crdt";
import type { DbClient } from "../db/types.js";
import { AppError } from "../errors/app-error.js";
import type { DocumentStore } from "./document-store.js";
import { getSnapshotAtOrBefore } from "./snapshot.repo.js";
import { getOperationsInRange } from "./op-log.repo.js";

/** A real (versioned) snapshot vs. the legacy `{chars:[]}` placeholder or absence. */
function isDocumentSnapshot(state: unknown): state is DocumentSnapshot {
  return (
    typeof state === "object" &&
    state !== null &&
    typeof (state as DocumentSnapshot).v === "number" &&
    typeof (state as DocumentSnapshot).clock === "number" &&
    Array.isArray((state as DocumentSnapshot).chars)
  );
}

export interface ReconstructedVersion {
  readonly version: number;
  readonly state: DocumentSnapshot;
  readonly text: string;
}

/**
 * Materialize the document as it was at `version`: the nearest snapshot at or before
 * `version`, with the op tail `(snapshot.seq, version]` replayed on top. Read-only;
 * builds a throwaway `RGADocument` (its identity is never used to mint anything).
 */
export async function reconstructVersion(
  db: DbClient,
  documentId: string,
  version: number,
): Promise<ReconstructedVersion> {
  const identity: DocumentIdentity = {
    replicaId: `reconstruct:${documentId}`,
    authorId: "reconstruct",
  };
  const snapshot = await getSnapshotAtOrBefore(db, documentId, version);
  const doc =
    snapshot && isDocumentSnapshot(snapshot.state)
      ? RGADocument.fromSnapshot(snapshot.state, identity)
      : new RGADocument(identity);
  const base = snapshot?.seq ?? 0;

  const tail = await getOperationsInRange(db, documentId, base, version);
  for (const { op } of tail) applyRemote(doc, op);

  return { version, state: doc.toSnapshot(), text: doc.text() };
}

/**
 * Diff `store.doc` against `targetText` and apply + persist the resulting forward ops.
 * The ops are minted with a fresh per-restore replica id (a real UUID, so they satisfy
 * `document_operations.replica_id` and never collide with any tab's char ids), attributed
 * to `userId`. Returns the ops (for broadcast) and the resulting text.
 */
export function applyRestore(
  store: DocumentStore,
  targetText: string,
  userId: string | null,
): { ops: Op[]; text: string } {
  const identity: DocumentIdentity = {
    replicaId: randomUUID(),
    authorId: userId ?? "restore",
  };
  const ops = reconcileToText(store.doc, targetText, identity);
  for (const op of ops) store.persist(op, userId);
  return { ops, text: store.doc.text() };
}

/** Fan-out surface a restore needs: the same two channels a socket `edit` uses. */
export interface RestoreBroadcaster {
  /** Deliver the restore ops to every connected client on every instance. */
  broadcast(documentId: string, ops: Op[], seq: number): void;
  /** Fold the restore ops into other instances' server-side materialized copies. */
  publishPeers(documentId: string, ops: Op[]): void;
}

export interface RestoreResult {
  /** The version that was restored to. */
  readonly restoredToVersion: number;
  /** The pre-restore snapshot seq — restore back to this to undo. */
  readonly restorePointVersion: number;
  /** The new durable watermark after the restore's ops landed. */
  readonly newVersion: number;
  /** Number of forward ops the restore produced (0 = target already matched). */
  readonly opCount: number;
  /** The document text after the restore. */
  readonly text: string;
}

export interface PerformRestoreDeps {
  readonly db: DbClient;
  readonly broadcaster: RestoreBroadcaster;
}

export interface PerformRestoreParams {
  readonly documentId: string;
  readonly version: number;
  readonly userId: string;
}

/**
 * Run a full restore against an already-acquired live `store` (the caller owns
 * acquire/release via the room manager so connected clients receive the ops):
 *
 *   1. validate the target version is not in the future;
 *   2. reconstruct the target text;
 *   3. snapshot a labelled restore point of CURRENT state (one-click undo);
 *   4. diff current → target and apply + persist the forward ops;
 *   5. broadcast to clients + fold into peer instances (same as an edit);
 *   6. flush + write a labelled post-restore snapshot (also refreshes the hot cache).
 *
 * A no-op restore (target already equals current) short-circuits: no restore point,
 * no ops, no snapshots.
 */
export async function performRestore(
  store: DocumentStore,
  deps: PerformRestoreDeps,
  params: PerformRestoreParams,
): Promise<RestoreResult> {
  const head = store.currentSeq;
  if (params.version < 0 || params.version > head) {
    throw AppError.badRequest(
      `Cannot restore to version ${params.version} (current version is ${head})`,
    );
  }

  const target = await reconstructVersion(deps.db, params.documentId, params.version);

  if (target.text === store.doc.text()) {
    return {
      restoredToVersion: params.version,
      restorePointVersion: head,
      newVersion: head,
      opCount: 0,
      text: target.text,
    };
  }

  // (3) Restore point: pre-restore state, labelled, attributed to the restorer.
  const restorePointVersion = await store.captureSnapshot({
    kind: "restore_point",
    label: `Before restore to v${params.version}`,
    createdBy: params.userId,
  });

  // (4) Forward diff, applied + persisted.
  const { ops, text } = applyRestore(store, target.text, params.userId);

  // (5) Same fan-out as a normal edit. `store.currentSeq` here is still the pre-flush
  //     watermark (persist is batched); the seq on a broadcast is advisory, and clients
  //     track the max seq they've seen, so this is safe.
  deps.broadcaster.broadcast(params.documentId, ops, store.currentSeq);
  deps.broadcaster.publishPeers(params.documentId, ops);

  // (6) Durable flush + labelled post-restore snapshot at the true new watermark.
  const newVersion = await store.captureSnapshot({
    kind: "post_restore",
    label: `Restored to v${params.version}`,
    createdBy: params.userId,
  });

  return {
    restoredToVersion: params.version,
    restorePointVersion,
    newVersion,
    opCount: ops.length,
    text,
  };
}
