import type { DbClient } from "../db/types.js";
import { AppError } from "../errors/app-error.js";
import { findDocumentById, findMember, type DocumentRecord } from "./documents.repo.js";

export type DocumentRole = "viewer" | "editor" | "owner";

const ROLE_RANK: Record<DocumentRole, number> = { viewer: 0, editor: 1, owner: 2 };

export interface AccessResult {
  document: DocumentRecord;
  role: DocumentRole;
}

/**
 * The single authorization gate for documents. Every HTTP route (and, later, the WebSocket doc
 * -room layer — same `DbClient`-based signature, no Express/socket coupling here) must call this
 * instead of hand-rolling ownership/membership checks, so there is exactly one definition of
 * "can user X do at-least-Y to document Z".
 *
 * A document that doesn't exist, is soft-deleted, or that the user has no access to at all
 * produce the identical 404 — a non-member must never be able to distinguish "this document
 * doesn't exist" from "this document exists but I can't see it". Insufficient role on a document
 * the user *can* see (member or public) is a 403 instead, since that doesn't leak anything the
 * caller doesn't already know.
 */
export async function assertCanAccess(
  db: DbClient,
  userId: string,
  documentId: string,
  minRole: DocumentRole,
): Promise<AccessResult> {
  const document = await findDocumentById(db, documentId);
  if (!document || document.deleted_at) {
    throw AppError.notFound("Document not found");
  }

  let role: DocumentRole | null = null;
  if (document.owner_id === userId) {
    role = "owner";
  } else {
    const member = await findMember(db, documentId, userId);
    if (member) {
      role = member.role;
    } else if (document.is_public) {
      // Public grants viewer to any authenticated user, not just members — see PLAN.md decision.
      role = "viewer";
    }
  }

  if (role === null) {
    throw AppError.notFound("Document not found");
  }

  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw AppError.forbidden(`Requires ${minRole} access`);
  }

  return { document, role };
}
