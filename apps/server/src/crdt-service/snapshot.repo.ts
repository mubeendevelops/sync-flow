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
