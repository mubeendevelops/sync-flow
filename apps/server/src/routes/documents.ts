import { Router } from "express";
import type { DbClient } from "../db/types.js";
import { AppError } from "../errors/app-error.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/require-auth.js";
import { assertCanAccess } from "../documents/permissions.js";
import {
  documentIdParamsSchema,
  memberParamsSchema,
  listDocumentsQuerySchema,
  createDocumentBodySchema,
  patchDocumentBodySchema,
  inviteBodySchema,
  listOperationsQuerySchema,
  versionParamsSchema,
  listVersionsQuerySchema,
  transferOwnerBodySchema,
} from "../documents/schemas.js";
import { listVersions, type VersionListItem } from "../documents/versions.repo.js";
import {
  reconstructVersion,
  performRestore,
  hydrateDocument,
  type RestoreBroadcaster,
  type CrdtStateCache,
} from "../crdt-service/index.js";
import type { DocumentStore } from "../crdt-service/index.js";
import {
  renderHtmlDocument,
  readCachedPdf,
  writeCachedPdf,
  pdfContentDisposition,
  type PdfRenderer,
} from "../documents/export/index.js";
import {
  listAccessibleDocuments,
  listCollaborators,
  createDocumentWithInitialSnapshot,
  updateDocument,
  softDeleteDocument,
  getLatestSnapshotSeq,
  listMembersWithUsers,
  findMember,
  upsertMember,
  removeMember,
  transferOwnership,
  listOperations,
  type DocumentRecord,
  type AccessibleDocument,
  type Collaborator,
  type MemberWithUser,
  type OperationRecord,
} from "../documents/documents.repo.js";
import { findUserByEmail, findUserById, toPublicUser } from "../auth/users.repo.js";

/**
 * Live-document surface the restore endpoint needs: acquire/release the shared
 * `DocumentStore` (so connected clients receive the restore ops) and a broadcaster to
 * fan the ops out. Optional — the versions LIST/GET endpoints work without it; only
 * POST /restore requires it, and it's always wired in the real server (see server.ts).
 */
export interface DocumentsRestoreDeps {
  readonly manager: {
    acquire(documentId: string): Promise<DocumentStore>;
    release(documentId: string): void;
  };
  readonly broadcaster: RestoreBroadcaster;
}

/**
 * Wiring for GET /export/pdf: the Redis cache (doubles as the CRDT hot-state cache used to
 * hydrate the current document, and the rendered-PDF cache) and the Chromium PDF renderer.
 * Optional — the renderer is injectable so tests can supply a fake instead of launching a
 * real browser, and the endpoint 500s cleanly if a deployment leaves it unwired.
 */
export interface DocumentsExportDeps {
  readonly cache: CrdtStateCache;
  readonly renderPdf: PdfRenderer;
}

export interface DocumentsRouterDeps {
  db: DbClient;
  jwtAccessSecret: string;
  /** Realtime wiring for POST /restore; omit to disable restore (list/get still work). */
  restore?: DocumentsRestoreDeps;
  /** Wiring for GET /export/pdf; omit to disable PDF export. */
  export?: DocumentsExportDeps;
}

const VERSION_PREVIEW_LENGTH = 140;

function toVersionDto(v: VersionListItem) {
  return {
    version: v.version,
    createdAt: v.createdAt,
    kind: v.kind,
    label: v.label,
    createdBy: v.createdBy,
    preview: v.preview,
    textLength: v.textLength,
    truncated: v.textLength > v.preview.length,
    contributors: v.contributors,
  };
}

function toDocumentDto(doc: DocumentRecord) {
  return {
    id: doc.id,
    title: doc.title,
    ownerId: doc.owner_id,
    isPublic: doc.is_public,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function toCollaboratorDto(c: Collaborator) {
  return {
    userId: c.user_id,
    username: c.username,
    displayName: c.display_name,
    presenceColor: c.presence_color,
    role: c.role,
  };
}

function toDocumentListItemDto(doc: AccessibleDocument, collaborators: Collaborator[]) {
  return {
    ...toDocumentDto(doc),
    role: doc.role,
    collaborators: collaborators.map(toCollaboratorDto),
  };
}

function toMemberDto(member: MemberWithUser) {
  return {
    userId: member.user_id,
    role: member.role,
    username: member.username,
    displayName: member.display_name,
    presenceColor: member.presence_color,
    joinedAt: member.created_at,
  };
}

function toOperationDto(op: OperationRecord) {
  return {
    id: op.id,
    seq: Number(op.seq),
    opType: op.op_type,
    charId: op.char_id,
    afterId: op.after_id,
    value: op.value,
    replicaId: op.replica_id,
    lamportClock: Number(op.lamport_clock),
    opVersion: op.op_version,
    userId: op.user_id,
    createdAt: op.created_at,
    formatKey: op.format_key,
  };
}

export function createDocumentsRouter(deps: DocumentsRouterDeps): Router {
  const router = Router();
  router.use(requireAuth({ jwtAccessSecret: deps.jwtAccessSecret }));

  router.get("/", validate({ query: listDocumentsQuerySchema }), async (req, res, next) => {
    try {
      const { page, pageSize } = req.query as unknown as { page: number; pageSize: number };
      const { documents, total } = await listAccessibleDocuments(deps.db, {
        userId: req.user!.id,
        page,
        pageSize,
      });
      const collaboratorsByDoc = await listCollaborators(
        deps.db,
        documents.map((d) => d.id),
      );
      res.status(200).json({
        documents: documents.map((doc) =>
          toDocumentListItemDto(doc, collaboratorsByDoc.get(doc.id) ?? []),
        ),
        pagination: { page, pageSize, total },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", validate({ body: createDocumentBodySchema }), async (req, res, next) => {
    try {
      const { title } = req.body as { title: string };
      const document = await createDocumentWithInitialSnapshot(deps.db, {
        title,
        ownerId: req.user!.id,
      });
      res.status(201).json({ document: toDocumentDto(document) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", validate({ params: documentIdParamsSchema }), async (req, res, next) => {
    try {
      const { id } = req.params as unknown as { id: string };
      const { document } = await assertCanAccess(deps.db, req.user!.id, id, "viewer");
      const [ownerUser, members, version] = await Promise.all([
        findUserById(deps.db, document.owner_id),
        listMembersWithUsers(deps.db, document.id),
        getLatestSnapshotSeq(deps.db, document.id),
      ]);
      res.status(200).json({
        document: toDocumentDto(document),
        owner: ownerUser ? toPublicUser(ownerUser) : null,
        members: members.map(toMemberDto),
        version,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    "/:id",
    validate({ params: documentIdParamsSchema, body: patchDocumentBodySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as unknown as { id: string };
        await assertCanAccess(deps.db, req.user!.id, id, "owner");
        const { title, isPublic } = req.body as { title?: string; isPublic?: boolean };
        const updated = await updateDocument(deps.db, id, { title, isPublic });
        res.status(200).json({ document: toDocumentDto(updated) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete("/:id", validate({ params: documentIdParamsSchema }), async (req, res, next) => {
    try {
      const { id } = req.params as unknown as { id: string };
      await assertCanAccess(deps.db, req.user!.id, id, "owner");
      await softDeleteDocument(deps.db, id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/:id/invite",
    validate({ params: documentIdParamsSchema, body: inviteBodySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const { document } = await assertCanAccess(deps.db, req.user!.id, id, "owner");
        const { email, role } = req.body as { email: string; role: "editor" | "viewer" };

        const targetUser = await findUserByEmail(deps.db, email);
        if (!targetUser) {
          next(AppError.notFound("No user found with that email"));
          return;
        }
        if (targetUser.id === document.owner_id) {
          next(AppError.conflict("This user already owns the document"));
          return;
        }

        const member = await upsertMember(deps.db, document.id, targetUser.id, role);
        res.status(201).json({
          member: toMemberDto({
            ...member,
            username: targetUser.username,
            display_name: targetUser.display_name,
            presence_color: targetUser.presence_color,
          }),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/:id/members/:userId",
    validate({ params: memberParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, userId } = req.params as unknown as { id: string; userId: string };
        const { document } = await assertCanAccess(deps.db, req.user!.id, id, "owner");

        if (userId === document.owner_id) {
          next(AppError.badRequest("Cannot remove the document owner"));
          return;
        }

        const removed = await removeMember(deps.db, document.id, userId);
        if (!removed) {
          next(AppError.notFound("Member not found"));
          return;
        }
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  // Owner-only. The target must already be a member (editor or viewer) — this is reachable
  // only by promoting someone already in the share dialog's member list, never an arbitrary
  // user, which keeps "who can end up owning my document" bounded to people I already invited.
  router.post(
    "/:id/transfer-owner",
    validate({ params: documentIdParamsSchema, body: transferOwnerBodySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const { userId: newOwnerId } = req.body as { userId: string };
        const { document } = await assertCanAccess(deps.db, req.user!.id, id, "owner");

        if (newOwnerId === document.owner_id) {
          next(AppError.badRequest("This user already owns the document"));
          return;
        }
        const targetMember = await findMember(deps.db, id, newOwnerId);
        if (!targetMember) {
          next(AppError.badRequest("User must already be a collaborator on this document"));
          return;
        }

        const updated = await transferOwnership(deps.db, id, newOwnerId, req.user!.id);
        if (!updated) {
          next(AppError.conflict("Ownership changed concurrently — please retry"));
          return;
        }
        res.status(200).json({ document: toDocumentDto(updated) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/:id/operations",
    validate({ params: documentIdParamsSchema, query: listOperationsQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as unknown as { id: string };
        await assertCanAccess(deps.db, req.user!.id, id, "viewer");
        const { cursor, limit } = req.query as unknown as { cursor: number; limit: number };
        const { operations, hasMore } = await listOperations(deps.db, {
          documentId: id,
          afterSeq: cursor,
          limit,
        });
        const nextCursor = hasMore ? String(operations[operations.length - 1].seq) : null;
        res.status(200).json({ operations: operations.map(toOperationDto), nextCursor });
      } catch (err) {
        next(err);
      }
    },
  );

  // ---- export -------------------------------------------------------------

  // Download the current document as a PDF. A read action — any member (owner/editor/viewer)
  // may export. Rendered server-side via headless Chromium and cached in Redis by content
  // version, so an unchanged document re-serves the cached buffer instead of re-rendering.
  router.get(
    "/:id/export/pdf",
    validate({ params: documentIdParamsSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const { document } = await assertCanAccess(deps.db, req.user!.id, id, "viewer");
        if (!deps.export) {
          throw AppError.internal("PDF export is not available on this server");
        }
        const { cache, renderPdf } = deps.export;

        // Hydrate the current durable CRDT state; `seq` is the content version (advances on
        // every op) and keys the PDF cache so any edit invalidates a stale render.
        const { doc, seq } = await hydrateDocument({ db: deps.db, cache }, id, {
          replicaId: `export:${id}`,
          authorId: "export",
        });

        let pdf = await readCachedPdf(cache, id, seq);
        if (!pdf) {
          pdf = await renderPdf(renderHtmlDocument(document.title, doc));
          await writeCachedPdf(cache, id, seq, pdf);
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", pdfContentDisposition(document.title));
        res.setHeader("Content-Length", pdf.length);
        res.status(200).send(pdf);
      } catch (err) {
        next(err);
      }
    },
  );

  // ---- version history ----------------------------------------------------

  // Paginated snapshot list = the version history (timestamp, contributors, preview).
  router.get(
    "/:id/versions",
    validate({ params: documentIdParamsSchema, query: listVersionsQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as unknown as { id: string };
        await assertCanAccess(deps.db, req.user!.id, id, "viewer");
        const { cursor, limit } = req.query as unknown as { cursor?: number; limit: number };
        const { versions, hasMore } = await listVersions(deps.db, {
          documentId: id,
          cursor: cursor ?? null,
          limit,
          previewLength: VERSION_PREVIEW_LENGTH,
        });
        const nextCursor = hasMore ? String(versions[versions.length - 1].version) : null;
        res.status(200).json({ versions: versions.map(toVersionDto), nextCursor });
      } catch (err) {
        next(err);
      }
    },
  );

  // Full document state at a version: nearest snapshot + replayed op tail.
  router.get(
    "/:id/versions/:version",
    validate({ params: versionParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, version } = req.params as unknown as { id: string; version: number };
        await assertCanAccess(deps.db, req.user!.id, id, "viewer");
        const reconstructed = await reconstructVersion(deps.db, id, version);
        res.status(200).json({
          version: reconstructed.version,
          text: reconstructed.text,
          state: reconstructed.state,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Restore to a version — owner-only. Not a destructive overwrite: it appends a forward
  // diff of ops (see crdt-service/restore.ts) so connected clients converge normally.
  router.post(
    "/:id/restore/:version",
    validate({ params: versionParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, version } = req.params as unknown as { id: string; version: number };
        await assertCanAccess(deps.db, req.user!.id, id, "owner");
        if (!deps.restore) {
          throw AppError.internal("Restore is not available on this server");
        }

        const { manager, broadcaster } = deps.restore;
        const store = await manager.acquire(id);
        try {
          const result = await performRestore(
            store,
            { db: deps.db, broadcaster },
            { documentId: id, version, userId: req.user!.id },
          );
          res.status(200).json({ restore: result });
        } finally {
          manager.release(id);
        }
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
