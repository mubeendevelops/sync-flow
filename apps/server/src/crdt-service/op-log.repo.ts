/**
 * The write path into `document_operations` and the read path back out (for replay).
 *
 * VERSION ASSIGNMENT — how "no two ops ever get the same version" is guaranteed:
 * `document_operations.seq` is a `BIGSERIAL UNIQUE`. Every INSERT draws its `seq`
 * from a Postgres sequence via `nextval`, which is:
 *   - atomic and non-transactional: two concurrent connections calling `nextval`
 *     can never receive the same value, even inside overlapping transactions, and
 *     a value is never handed out twice;
 *   - gap-tolerant by design: a rolled-back or interleaved (other-document) INSERT
 *     may burn a number, but the sync protocol only needs seq to be
 *     unique-and-monotonic, not gapless.
 * So we take NO application-level lock and run NO optimistic retry:
 *   - a row lock (`SELECT ... FOR UPDATE` on the document) would serialize every
 *     write to a document behind one lock — a throughput chokepoint for the exact
 *     concurrency we care about, and redundant given the sequence;
 *   - read-max+1-then-insert-retry-on-conflict thrashes under concurrency and is
 *     strictly worse than a sequence.
 * The sequence is lock-free, contention-free, and unaffected by batching (each row
 * still draws its own `nextval`). `concurrent-writes.test.ts` hammers this from many
 * connections at once and asserts zero duplicate seqs and zero lost ops.
 */

import type { DbClient } from "../db/types.js";
import { type Op } from "@sync-flow/crdt";
import {
  opToRowValues,
  rowToOp,
  type PendingOp,
  type OperationRow,
  type OperationRowValues,
} from "./row-mapping.js";

export type { PendingOp } from "./row-mapping.js";

/** A persisted operation: its server-assigned version (`seq`) alongside the original op. */
export interface PersistedOp {
  readonly seq: number;
  readonly charId: string;
  readonly op: Op;
}

const INSERT_COLUMNS: (keyof OperationRowValues)[] = [
  "document_id",
  "user_id",
  "op_type",
  "char_id",
  "after_id",
  "value",
  "replica_id",
  "lamport_clock",
  "op_version",
];

/**
 * Append a batch of ops in a single multi-row INSERT and return them with their
 * server-assigned `seq`. One statement → statement-level atomicity: either every
 * row in the batch commits or none does, so a failed flush can be retried whole
 * without risking a partial write.
 *
 * The batch may be a single op; there is nothing special about batch size here —
 * batching is a throughput concern owned by `OpWriter`, not a correctness one.
 */
export async function appendOperations(
  db: DbClient,
  documentId: string,
  batch: PendingOp[],
): Promise<PersistedOp[]> {
  if (batch.length === 0) return [];

  const params: unknown[] = [];
  const rowsSql = batch.map((pending, i) => {
    const values = opToRowValues(documentId, pending);
    const base = i * INSERT_COLUMNS.length;
    for (const col of INSERT_COLUMNS) params.push(values[col]);
    const placeholders = INSERT_COLUMNS.map((_, c) => `$${base + c + 1}`);
    return `(${placeholders.join(", ")})`;
  });

  // RETURNING preserves the VALUES row order for a single INSERT, so we map results
  // back to the input ops by index — unambiguous even when one batch both inserts
  // and deletes the same char_id (same key, different rows).
  const { rows } = await db.query<{ seq: string; char_id: string }>(
    `INSERT INTO document_operations (${INSERT_COLUMNS.join(", ")})
     VALUES ${rowsSql.join(", ")}
     RETURNING seq, char_id`,
    params,
  );

  return rows.map((row, i) => ({
    seq: Number(row.seq),
    charId: row.char_id,
    op: batch[i]!.op,
  }));
}

/** A replayed op paired with its server-assigned version. */
export interface ReplayOp {
  readonly seq: number;
  readonly op: Op;
}

/**
 * All operations with `seq > afterSeq` for a document, oldest first — the tail to
 * replay on top of a snapshot taken at `afterSeq`. Each op carries its `seq` so the
 * caller can advance the watermark: `seq` is a GLOBAL BIGSERIAL, so a document's
 * seqs have gaps and the new watermark is the last row's seq, never a count.
 * Between snapshots this is bounded by the snapshot policy (~100 ops), so a single
 * unpaginated read is fine.
 */
export async function getOperationsAfter(
  db: DbClient,
  documentId: string,
  afterSeq: number,
): Promise<ReplayOp[]> {
  const { rows } = await db.query<OperationRow & { seq: string }>(
    `SELECT seq, op_type, char_id, after_id, value, replica_id, lamport_clock, op_version,
            user_id, created_at
     FROM document_operations
     WHERE document_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [documentId, afterSeq],
  );
  return rows.map((row) => ({ seq: Number(row.seq), op: rowToOp(row) }));
}
