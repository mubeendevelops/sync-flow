/**
 * Read model for the version-history list. A "version" is a persisted snapshot row
 * (the periodic ~100-op/30s cadence + last-disconnect + labelled restore checkpoints),
 * enriched for display with:
 *   - a short plain-text preview (denormalized `plain_text`, so no CRDT replay needed);
 *   - the contributors who authored the ops that landed in this snapshot's window,
 *     i.e. ops with `prevSnapshot.seq < seq <= thisSnapshot.seq`.
 *
 * Keyset pagination on `seq` DESC (newest first): the op/snapshot log is append-only
 * and unbounded, so offset pagination would only get slower and less stable over time.
 */

import type { DbClient } from "../db/types.js";

export interface VersionContributor {
  readonly userId: string;
  readonly displayName: string;
}

export interface VersionListItem {
  readonly version: number;
  readonly createdAt: Date;
  readonly kind: string;
  readonly label: string | null;
  readonly createdBy: string | null;
  readonly preview: string;
  readonly textLength: number;
  readonly contributors: VersionContributor[];
}

export interface ListVersionsInput {
  readonly documentId: string;
  /** Return versions with `seq < cursor` (newest first); null for the first page. */
  readonly cursor: number | null;
  readonly limit: number;
  /** Preview length in characters. */
  readonly previewLength: number;
}

interface VersionRow {
  readonly seq: string;
  readonly created_at: Date;
  readonly kind: string;
  readonly label: string | null;
  readonly created_by: string | null;
  readonly preview: string;
  readonly text_length: number;
  readonly contributors: VersionContributor[];
}

export async function listVersions(
  db: DbClient,
  input: ListVersionsInput,
): Promise<{ versions: VersionListItem[]; hasMore: boolean }> {
  const { rows } = await db.query<VersionRow>(
    `SELECT s.seq,
            s.created_at,
            s.kind,
            s.label,
            s.created_by,
            substring(s.plain_text FROM 1 FOR $4) AS preview,
            char_length(s.plain_text) AS text_length,
            COALESCE(
              (
                SELECT json_agg(
                         json_build_object('userId', u.id, 'displayName', u.display_name)
                         ORDER BY u.display_name
                       )
                FROM (
                  SELECT DISTINCT o.user_id
                  FROM document_operations o
                  WHERE o.document_id = s.document_id
                    AND o.user_id IS NOT NULL
                    AND o.seq <= s.seq
                    AND o.seq > COALESCE(
                      (SELECT ps.seq FROM document_snapshots ps
                       WHERE ps.document_id = s.document_id AND ps.seq < s.seq
                       ORDER BY ps.seq DESC LIMIT 1),
                      -1
                    )
                ) du
                JOIN users u ON u.id = du.user_id
              ),
              '[]'::json
            ) AS contributors
     FROM document_snapshots s
     WHERE s.document_id = $1
       AND ($2::bigint IS NULL OR s.seq < $2)
     ORDER BY s.seq DESC
     LIMIT $3`,
    [input.documentId, input.cursor, input.limit + 1, input.previewLength],
  );

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const versions = page.map((row) => ({
    version: Number(row.seq),
    createdAt: row.created_at,
    kind: row.kind,
    label: row.label,
    createdBy: row.created_by,
    preview: row.preview ?? "",
    textLength: row.text_length,
    contributors: row.contributors,
  }));
  return { versions, hasMore };
}
