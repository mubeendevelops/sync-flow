/**
 * Translation between the pure CRDT `Op` shape (from `@sync-flow/crdt`) and the
 * `document_operations` row shape. This is the ONLY place that knows both, so the
 * CRDT package stays framework-/DB-free and the DB layer stays CRDT-internals-free.
 *
 * Note on `userId`: the acting user is server-side session context (the
 * authenticated socket), NOT something we trust from the client op. An InsertOp
 * carries an `authorId` for CRDT metadata, but we persist the server-known
 * `userId` into `user_id` and never the client-supplied field. A DeleteOp has no
 * author field at all, which is exactly why `userId` is passed alongside the op.
 */

import {
  type Op,
  type InsertOp,
  type DeleteOp,
  type ReviveOp,
  encodeId,
  decodeId,
} from "@sync-flow/crdt";

type OpType = "insert" | "delete" | "revive";

/** An op plus the authenticated user who produced it (server session context). */
export interface PendingOp {
  readonly op: Op;
  /** Authenticated actor; nullable so a system/replayed op without a user is representable. */
  readonly userId: string | null;
}

/** Column values for one `document_operations` row, minus the DB-assigned `seq`/`id`/`created_at`. */
export interface OperationRowValues {
  readonly document_id: string;
  readonly user_id: string | null;
  readonly op_type: OpType;
  readonly char_id: string;
  readonly after_id: string | null;
  readonly value: string | null;
  readonly replica_id: string;
  readonly lamport_clock: number;
  readonly op_version: number;
}

/** A persisted row as read back for replay (subset of `document_operations`). */
export interface OperationRow {
  readonly op_type: OpType;
  readonly char_id: string;
  readonly after_id: string | null;
  readonly value: string | null;
  readonly replica_id: string;
  readonly lamport_clock: string; // BIGINT comes back as string from pg
  readonly op_version: number;
  readonly user_id: string | null;
  readonly created_at: Date;
}

/** CRDT op → row values for INSERT. */
export function opToRowValues(documentId: string, pending: PendingOp): OperationRowValues {
  const { op, userId } = pending;
  if (op.type === "insert") {
    return {
      document_id: documentId,
      user_id: userId,
      op_type: "insert",
      char_id: encodeId(op.charId),
      after_id: encodeId(op.afterId),
      value: op.value,
      // For an insert, the minting replica/clock ARE the char's identity.
      replica_id: op.charId.replicaId,
      lamport_clock: op.charId.clock,
      op_version: op.opVersion,
    };
  }
  // delete + revive share a shape: they target an existing char and carry the actor's
  // own clock/replica (the LWW visibility stamp), with no after_id/value.
  return {
    document_id: documentId,
    user_id: userId,
    op_type: op.type,
    char_id: encodeId(op.charId),
    after_id: null,
    value: null,
    replica_id: op.replicaId,
    lamport_clock: op.clock,
    op_version: op.opVersion,
  };
}

/** Persisted row → CRDT op, for replaying the log on top of a snapshot. */
export function rowToOp(row: OperationRow): Op {
  if (row.op_type === "insert") {
    if (row.after_id === null || row.value === null) {
      throw new Error("corrupt insert row: missing after_id/value");
    }
    const op: InsertOp = {
      type: "insert",
      charId: decodeId(row.char_id),
      afterId: decodeId(row.after_id),
      value: row.value,
      // authorId is CRDT metadata only; user_id may be NULL after a user hard-delete.
      authorId: row.user_id ?? "",
      timestamp: row.created_at.getTime(),
      opVersion: row.op_version,
    };
    return op;
  }
  // delete + revive decode identically; only the discriminant differs.
  if (row.op_type === "revive") {
    const op: ReviveOp = {
      type: "revive",
      charId: decodeId(row.char_id),
      clock: Number(row.lamport_clock),
      replicaId: row.replica_id,
      opVersion: row.op_version,
    };
    return op;
  }
  const op: DeleteOp = {
    type: "delete",
    charId: decodeId(row.char_id),
    clock: Number(row.lamport_clock),
    replicaId: row.replica_id,
    opVersion: row.op_version,
  };
  return op;
}
