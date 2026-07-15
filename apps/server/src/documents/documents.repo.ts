import type { DbClient } from "../db/types.js";
import { SNAPSHOT_VERSION, type DocumentSnapshot } from "@sync-flow/crdt";

export interface DocumentRecord {
  id: string;
  title: string;
  owner_id: string;
  is_public: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const DOCUMENT_COLUMNS = "id, title, owner_id, is_public, deleted_at, created_at, updated_at";

// A real, empty `@sync-flow/crdt` DocumentSnapshot for a brand-new document's version-0 row:
// no chars, Lamport clock 0. This is the shape `RGADocument.fromSnapshot` expects, replacing
// the earlier `{ chars: [] }` placeholder now that packages/crdt has landed (hydrate.ts also
// tolerates that legacy shape by treating it as empty).
const EMPTY_CRDT_STATE: DocumentSnapshot = { v: SNAPSHOT_VERSION, clock: 0, chars: [] };
const EMPTY_CRDT_STATE_JSON = JSON.stringify(EMPTY_CRDT_STATE);

export async function findDocumentById(db: DbClient, id: string): Promise<DocumentRecord | null> {
  const { rows } = await db.query<DocumentRecord>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface ListAccessibleDocumentsInput {
  userId: string;
  page: number;
  pageSize: number;
}

/** Owner or member role on a specific document — "owner" is derived from `documents.owner_id`,
 * never stored as a `document_members` row (see permissions.ts's `assertCanAccess`). */
export type DocumentAccessRole = "owner" | MemberRole;

export interface AccessibleDocument extends DocumentRecord {
  role: DocumentAccessRole;
}

export async function listAccessibleDocuments(
  db: DbClient,
  input: ListAccessibleDocumentsInput,
): Promise<{ documents: AccessibleDocument[]; total: number }> {
  const offset = (input.page - 1) * input.pageSize;
  // LEFT JOIN (rather than the old EXISTS) so the requester's role comes back for free — a doc
  // only ever matches the WHERE clause via ownership or exactly one membership row, so this
  // can't duplicate rows.
  const { rows } = await db.query<
    DocumentRecord & { role: DocumentAccessRole; total_count: string }
  >(
    `SELECT d.*,
            CASE WHEN d.owner_id = $1 THEN 'owner' ELSE m.role::text END AS role,
            COUNT(*) OVER() AS total_count
     FROM documents d
     LEFT JOIN document_members m ON m.document_id = d.id AND m.user_id = $1
     WHERE d.deleted_at IS NULL
       AND (d.owner_id = $1 OR m.user_id = $1)
     ORDER BY d.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [input.userId, input.pageSize, offset],
  );
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  return { documents: rows.map(({ total_count: _total_count, ...doc }) => doc), total };
}

export interface Collaborator {
  document_id: string;
  user_id: string;
  role: DocumentAccessRole;
  username: string;
  display_name: string;
  presence_color: string;
}

/**
 * Batched owner+members lookup for a page of documents' avatar stacks — one query for owners,
 * one for members, grouped in JS, instead of N+1 per-document queries.
 */
export async function listCollaborators(
  db: DbClient,
  documentIds: string[],
): Promise<Map<string, Collaborator[]>> {
  const byDocument = new Map<string, Collaborator[]>();
  if (documentIds.length === 0) return byDocument;

  const [{ rows: owners }, { rows: members }] = await Promise.all([
    db.query<Collaborator>(
      `SELECT d.id AS document_id, u.id AS user_id, 'owner' AS role,
              u.username, u.display_name, u.presence_color
       FROM documents d
       JOIN users u ON u.id = d.owner_id
       WHERE d.id = ANY($1)`,
      [documentIds],
    ),
    db.query<Collaborator>(
      `SELECT m.document_id, u.id AS user_id, m.role,
              u.username, u.display_name, u.presence_color
       FROM document_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.document_id = ANY($1)
       ORDER BY m.created_at ASC`,
      [documentIds],
    ),
  ]);

  for (const row of [...owners, ...members]) {
    const existing = byDocument.get(row.document_id);
    if (existing) existing.push(row);
    else byDocument.set(row.document_id, [row]);
  }
  return byDocument;
}

export interface CreateDocumentInput {
  title: string;
  ownerId: string;
}

/** Atomically creates the document and its version-0 (empty) snapshot in one statement. */
export async function createDocumentWithInitialSnapshot(
  db: DbClient,
  input: CreateDocumentInput,
): Promise<DocumentRecord> {
  const { rows } = await db.query<DocumentRecord>(
    `WITH new_document AS (
       INSERT INTO documents (title, owner_id)
       VALUES ($1, $2)
       RETURNING ${DOCUMENT_COLUMNS}
     ),
     initial_snapshot AS (
       INSERT INTO document_snapshots (document_id, seq, state, plain_text)
       SELECT id, 0, $3::jsonb, '' FROM new_document
     )
     SELECT * FROM new_document`,
    [input.title, input.ownerId, EMPTY_CRDT_STATE_JSON],
  );
  return rows[0];
}

export interface UpdateDocumentInput {
  title?: string;
  isPublic?: boolean;
}

export async function updateDocument(
  db: DbClient,
  id: string,
  input: UpdateDocumentInput,
): Promise<DocumentRecord> {
  const { rows } = await db.query<DocumentRecord>(
    `UPDATE documents
     SET title = COALESCE($2, title), is_public = COALESCE($3, is_public)
     WHERE id = $1
     RETURNING ${DOCUMENT_COLUMNS}`,
    [id, input.title ?? null, input.isPublic ?? null],
  );
  return rows[0];
}

export async function softDeleteDocument(db: DbClient, id: string): Promise<void> {
  await db.query(`UPDATE documents SET deleted_at = now() WHERE id = $1`, [id]);
}

export async function getLatestSnapshotSeq(db: DbClient, documentId: string): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(
    `SELECT seq FROM document_snapshots WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
    [documentId],
  );
  return rows[0] ? Number(rows[0].seq) : 0;
}

export type MemberRole = "editor" | "viewer";

export interface MemberRecord {
  document_id: string;
  user_id: string;
  role: MemberRole;
  created_at: Date;
  updated_at: Date;
}

export async function findMember(
  db: DbClient,
  documentId: string,
  userId: string,
): Promise<MemberRecord | null> {
  const { rows } = await db.query<MemberRecord>(
    `SELECT document_id, user_id, role, created_at, updated_at
     FROM document_members WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId],
  );
  return rows[0] ?? null;
}

export interface MemberWithUser extends MemberRecord {
  username: string;
  display_name: string;
  presence_color: string;
}

/** Joined with users so a member list is directly renderable without N+1 lookups. */
export async function listMembersWithUsers(
  db: DbClient,
  documentId: string,
): Promise<MemberWithUser[]> {
  const { rows } = await db.query<MemberWithUser>(
    `SELECT m.document_id, m.user_id, m.role, m.created_at, m.updated_at,
            u.username, u.display_name, u.presence_color
     FROM document_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.document_id = $1
     ORDER BY m.created_at ASC`,
    [documentId],
  );
  return rows;
}

/** Add-or-change-role — inviting an existing member updates their role rather than conflicting. */
export async function upsertMember(
  db: DbClient,
  documentId: string,
  userId: string,
  role: MemberRole,
): Promise<MemberRecord> {
  const { rows } = await db.query<MemberRecord>(
    `INSERT INTO document_members (document_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
     RETURNING document_id, user_id, role, created_at, updated_at`,
    [documentId, userId, role],
  );
  return rows[0];
}

export async function removeMember(
  db: DbClient,
  documentId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `DELETE FROM document_members WHERE document_id = $1 AND user_id = $2 RETURNING user_id`,
    [documentId, userId],
  );
  return rows.length > 0;
}

/**
 * Transfers ownership to an existing member. `DbClient` exposes only a single `query()` (no
 * dedicated connection to BEGIN/COMMIT on — see db/types.ts), so this is one statement built
 * from three data-modifying CTEs, atomic by virtue of being one round-trip: the owner_id update
 * is gated on the caller still being the current owner (`WHERE owner_id = $3`), and the
 * member-table changes are gated on that update having actually matched a row, so a lost
 * ownership race leaves everything untouched instead of partially applying.
 * The old owner keeps `editor` access as a member row instead of losing the document outright;
 * the new owner's membership row is removed since ownership now lives in `documents.owner_id`,
 * not `document_members` (consistent with how `assertCanAccess` computes "owner").
 */
export async function transferOwnership(
  db: DbClient,
  documentId: string,
  newOwnerId: string,
  currentOwnerId: string,
): Promise<DocumentRecord | null> {
  const { rows } = await db.query<DocumentRecord>(
    `WITH updated_doc AS (
       UPDATE documents
       SET owner_id = $2, updated_at = now()
       WHERE id = $1 AND owner_id = $3
       RETURNING ${DOCUMENT_COLUMNS}
     ),
     removed_member AS (
       DELETE FROM document_members
       WHERE document_id IN (SELECT id FROM updated_doc) AND user_id = $2
       RETURNING document_id
     ),
     old_owner_membership AS (
       INSERT INTO document_members (document_id, user_id, role)
       SELECT id, $3, 'editor' FROM updated_doc
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = 'editor', updated_at = now()
       RETURNING document_id
     )
     SELECT * FROM updated_doc`,
    [documentId, newOwnerId, currentOwnerId],
  );
  return rows[0] ?? null;
}

export interface OperationRecord {
  id: string;
  document_id: string;
  user_id: string | null;
  seq: string;
  op_type: "insert" | "delete" | "revive" | "format";
  char_id: string;
  after_id: string | null;
  value: string | null;
  replica_id: string;
  lamport_clock: string;
  op_version: number;
  created_at: Date;
  format_key: string | null;
}

export interface ListOperationsInput {
  documentId: string;
  afterSeq: number;
  limit: number;
}

/** Keyset/cursor pagination on `seq` — the operation log is append-only and can grow large, so
 * offset pagination would only get slower and less stable over time as this table grows. */
export async function listOperations(
  db: DbClient,
  input: ListOperationsInput,
): Promise<{ operations: OperationRecord[]; hasMore: boolean }> {
  const { rows } = await db.query<OperationRecord>(
    `SELECT id, document_id, user_id, seq, op_type, char_id, after_id, value, replica_id,
            lamport_clock, op_version, created_at, format_key
     FROM document_operations
     WHERE document_id = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [input.documentId, input.afterSeq, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  return { operations: hasMore ? rows.slice(0, input.limit) : rows, hasMore };
}
