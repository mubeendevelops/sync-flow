/**
 * Read/write of `document_snapshots` — the durable materialized CRDT state.
 * There is deliberately NO `document_content` table (see PLAN Decision Log): the
 * latest snapshot row IS the current durable state, and we never do a per-op state
 * UPDATE. Current state is rebuilt as `fromSnapshot(state)` + replay(ops WHERE
 * seq > snapshot.seq).
 */

import type { DbClient } from "../db/types.js";
import { type DocumentSnapshot } from "@sync-flow/crdt";

export interface StoredSnapshot {
  readonly seq: number;
  readonly state: DocumentSnapshot;
}

/**
 * The `seq` of the SECOND-most-recent snapshot — the "replay floor" for `sync`.
 *
 * Operation retention (PLAN 2.11) keeps ops back through the 2 most recent snapshots,
 * so every op with `seq > this` is guaranteed still retained and can be served as a
 * catch-up tail. A client at or above this version can be caught up with ops; a client
 * BELOW it may be missing pruned ops and must be sent a full snapshot instead.
 *
 * Returns 0 when fewer than 2 snapshots exist — nothing has been pruned yet, so any
 * version is replayable from the op log. (Every document has a version-0 snapshot from
 * creation, so "fewer than 2" means "no post-creation snapshot has fired yet".) Basing
 * the floor on the snapshot seq — not `MIN(op.seq)` — is deliberate: `seq` is a GLOBAL
 * BIGSERIAL with per-document gaps, so a document's first op can have `seq > 1` with no
 * pruning involved, and a `MIN(op.seq)` floor would wrongly strand version-0 clients.
 */
export async function getReplayFloor(db: DbClient, documentId: string): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(
    `SELECT seq FROM document_snapshots
     WHERE document_id = $1 ORDER BY seq DESC OFFSET 1 LIMIT 1`,
    [documentId],
  );
  return rows[0] ? Number(rows[0].seq) : 0;
}

/** The most recent snapshot for a document, or null if none exists yet. */
export async function getLatestSnapshot(
  db: DbClient,
  documentId: string,
): Promise<StoredSnapshot | null> {
  const { rows } = await db.query<{ seq: string; state: DocumentSnapshot }>(
    `SELECT seq, state FROM document_snapshots
     WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
    [documentId],
  );
  const row = rows[0];
  return row ? { seq: Number(row.seq), state: row.state } : null;
}

/**
 * Write a snapshot at watermark `seq`. `plainText` is the denormalized visible
 * text (for previews) and is kept in the same row as `state` so it can't drift.
 * `ON CONFLICT DO NOTHING` on (document_id, seq) makes a re-snapshot at the same
 * watermark a no-op rather than a unique-violation, which keeps snapshotting
 * idempotent under retries.
 */
export async function writeSnapshot(
  db: DbClient,
  documentId: string,
  seq: number,
  state: DocumentSnapshot,
  plainText: string,
): Promise<void> {
  await db.query(
    `INSERT INTO document_snapshots (document_id, seq, state, plain_text)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (document_id, seq) DO NOTHING`,
    [documentId, seq, JSON.stringify(state), plainText],
  );
}
