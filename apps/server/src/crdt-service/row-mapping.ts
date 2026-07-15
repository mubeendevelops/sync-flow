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
  type FormatOp,
  encodeId,
  decodeId,
} from "@sync-flow/crdt";

type OpType = "insert" | "delete" | "revive" | "format";

/**
 * Format keys whose value is always boolean (present) or `null` (cleared) — never a string.
 * Needed to deserialize `document_operations.value` back to the right JS type, since Postgres
 * only stores TEXT: `"true"` unambiguously means boolean `true` for these keys, whereas for a
 * string-valued key (e.g. `link`, whose href could coincidentally be the text "true") the raw
 * text is always the value verbatim. Must be kept in sync with the bridge's `MARK_KEYS`/
 * block-attribute keys (`apps/web/src/lib/crdt-bridge.ts`) — this is the ONLY server-side
 * place that needs to know the distinction, everywhere else a `FormatOp.value` is opaque.
 */
const BOOLEAN_FORMAT_KEYS = new Set(["bold", "italic", "code"]);

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
  /** Format attribute name; only present for `op_type = 'format'`. */
  readonly format_key: string | null;
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
  readonly format_key: string | null;
}

/** Serialize a `FormatOp.value` to the row's TEXT `value` column. */
function encodeFormatValue(value: string | boolean | null): string | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value; // string value verbatim
}

/** Inverse of {@link encodeFormatValue}, using `format_key` to disambiguate boolean vs string. */
function decodeFormatValue(key: string, raw: string | null): string | boolean | null {
  if (raw === null) return null;
  return BOOLEAN_FORMAT_KEYS.has(key) ? raw === "true" : raw;
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
      format_key: null,
    };
  }
  if (op.type === "format") {
    return {
      document_id: documentId,
      user_id: userId,
      op_type: "format",
      char_id: encodeId(op.charId),
      after_id: null,
      value: encodeFormatValue(op.value),
      replica_id: op.replicaId,
      lamport_clock: op.clock,
      op_version: op.opVersion,
      format_key: op.key,
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
    format_key: null,
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
  if (row.op_type === "format") {
    if (row.format_key === null) {
      throw new Error("corrupt format row: missing format_key");
    }
    const op: FormatOp = {
      type: "format",
      charId: decodeId(row.char_id),
      key: row.format_key,
      value: decodeFormatValue(row.format_key, row.value),
      clock: Number(row.lamport_clock),
      replicaId: row.replica_id,
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
