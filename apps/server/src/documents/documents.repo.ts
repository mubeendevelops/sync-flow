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

export async function listAccessibleDocuments(
  db: DbClient,
  input: ListAccessibleDocumentsInput,
): Promise<{ documents: DocumentRecord[]; total: number }> {
  const offset = (input.page - 1) * input.pageSize;
  const { rows } = await db.query<DocumentRecord & { total_count: string }>(
    `SELECT d.*, COUNT(*) OVER() AS total_count
     FROM documents d
     WHERE d.deleted_at IS NULL
       AND (d.owner_id = $1 OR EXISTS (
         SELECT 1 FROM document_members m WHERE m.document_id = d.id AND m.user_id = $1
       ))
     ORDER BY d.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [input.userId, input.pageSize, offset],
  );
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  return { documents: rows.map(({ total_count: _total_count, ...doc }) => doc), total };
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

export interface OperationRecord {
  id: string;
  document_id: string;
  user_id: string | null;
  seq: string;
  op_type: "insert" | "delete" | "revive";
  char_id: string;
  after_id: string | null;
  value: string | null;
  replica_id: string;
  lamport_clock: string;
  op_version: number;
  created_at: Date;
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
            lamport_clock, op_version, created_at
     FROM document_operations
     WHERE document_id = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [input.documentId, input.afterSeq, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  return { operations: hasMore ? rows.slice(0, input.limit) : rows, hasMore };
}
