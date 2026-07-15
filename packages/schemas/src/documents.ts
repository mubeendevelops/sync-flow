import { z } from "zod";
import { publicUserSchema } from "./auth.js";

// ---- request schemas (single source of truth — apps/server re-exports these) --------------

export const documentIdParamsSchema = z.object({ id: z.uuid() });
export const memberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() });

export const listDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createDocumentBodySchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be at most 200 characters"),
});
export type CreateDocumentBody = z.infer<typeof createDocumentBodySchema>;

export const patchDocumentBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((data) => data.title !== undefined || data.isPublic !== undefined, {
    message: "At least one of title or isPublic must be provided",
  });
export type PatchDocumentBody = z.infer<typeof patchDocumentBodySchema>;

export const inviteBodySchema = z.object({
  email: z.email(),
  role: z.enum(["editor", "viewer"]),
});
export type InviteBody = z.infer<typeof inviteBodySchema>;

export const listOperationsQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** `:version` is a server-assigned op/snapshot seq (see document_operations.seq). */
export const versionParamsSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().min(0),
});

export const listVersionsQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---- response DTOs (mirror apps/server/src/routes/documents.ts's toXDto() output) -----------
// NOTE: these are not yet runtime-validated on the server (it returns hand-shaped objects, not
// zod-parsed ones) — see PLAN.md Decision Log. They're the single source of TYPES for apps/web.

export const documentRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type DocumentRole = z.infer<typeof documentRoleSchema>;

export const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  ownerId: z.uuid(),
  isPublic: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Document = z.infer<typeof documentSchema>;

export const memberSchema = z.object({
  userId: z.uuid(),
  role: documentRoleSchema,
  username: z.string(),
  displayName: z.string(),
  presenceColor: z.string(),
  joinedAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const paginationSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/** A collaborator on a document — the owner plus every `document_members` row, for the
 * dashboard's avatar stack. Distinct from `memberSchema`: that one is membership-row-shaped
 * (has `joinedAt`), this one is just "who has access and at what role". */
export const collaboratorSchema = z.object({
  userId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  presenceColor: z.string(),
  role: documentRoleSchema,
});
export type Collaborator = z.infer<typeof collaboratorSchema>;

/** GET /documents list items carry the requester's own `role` and the full `collaborators` list
 * (dashboard role badge + avatar stack) — the single-document GET returns `owner`/`members`
 * separately instead, so this is its own schema rather than reusing `documentSchema`. */
export const documentListItemSchema = documentSchema.extend({
  role: documentRoleSchema,
  collaborators: z.array(collaboratorSchema),
});
export type DocumentListItem = z.infer<typeof documentListItemSchema>;

export const listDocumentsResponseSchema = z.object({
  documents: z.array(documentListItemSchema),
  pagination: paginationSchema,
});
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

/** Shared by every endpoint that just echoes back `{ document }` — create, patch, transfer-owner. */
export const documentResponseSchema = z.object({ document: documentSchema });
export const createDocumentResponseSchema = documentResponseSchema;
export const patchDocumentResponseSchema = documentResponseSchema;

export const getDocumentResponseSchema = z.object({
  document: documentSchema,
  owner: publicUserSchema.nullable(),
  members: z.array(memberSchema),
  version: z.number().int(),
});
export type GetDocumentResponse = z.infer<typeof getDocumentResponseSchema>;

export const inviteMemberResponseSchema = z.object({ member: memberSchema });

export const operationSchema = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  opType: z.enum(["insert", "delete", "revive", "format"]),
  charId: z.string(),
  afterId: z.string().nullable(),
  value: z.string().nullable(),
  replicaId: z.string(),
  lamportClock: z.number().int(),
  opVersion: z.number().int(),
  userId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** Format attribute name; only present when `opType === "format"`. */
  formatKey: z.string().nullable(),
});
export type Operation = z.infer<typeof operationSchema>;

export const listOperationsResponseSchema = z.object({
  operations: z.array(operationSchema),
  nextCursor: z.string().nullable(),
});

// Matches versions.repo.ts's `json_build_object('userId', ..., 'displayName', ...)` exactly —
// no `username` (the contributors query never joins it in), both fields always present because
// the underlying query filters to `o.user_id IS NOT NULL`.
export const versionContributorSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
});

export const versionListItemSchema = z.object({
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  kind: z.string(),
  label: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  preview: z.string(),
  textLength: z.number().int(),
  truncated: z.boolean(),
  contributors: z.array(versionContributorSchema),
});
export type VersionListItem = z.infer<typeof versionListItemSchema>;

export const listVersionsResponseSchema = z.object({
  versions: z.array(versionListItemSchema),
  nextCursor: z.string().nullable(),
});

export const versionPreviewResponseSchema = z.object({
  version: z.number().int(),
  text: z.string(),
  state: z.unknown(),
});

export const restoreResultSchema = z.object({
  restoredToVersion: z.number().int(),
  restorePointVersion: z.number().int(),
  newVersion: z.number().int(),
  opCount: z.number().int(),
  text: z.string(),
});

export const restoreResponseSchema = z.object({ restore: restoreResultSchema });

// ---- owner transfer ---------------------------------------------------------------------

export const transferOwnerBodySchema = z.object({
  userId: z.uuid(),
});
export type TransferOwnerBody = z.infer<typeof transferOwnerBodySchema>;

export const transferOwnerResponseSchema = documentResponseSchema;
