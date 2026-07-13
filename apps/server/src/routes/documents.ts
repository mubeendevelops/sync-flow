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
} from "../documents/schemas.js";
import {
  listAccessibleDocuments,
  createDocumentWithInitialSnapshot,
  updateDocument,
  softDeleteDocument,
  getLatestSnapshotSeq,
  listMembersWithUsers,
  upsertMember,
  removeMember,
  listOperations,
  type DocumentRecord,
  type MemberWithUser,
  type OperationRecord,
} from "../documents/documents.repo.js";
import { findUserByEmail, findUserById, toPublicUser } from "../auth/users.repo.js";

export interface DocumentsRouterDeps {
  db: DbClient;
  jwtAccessSecret: string;
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
      res.status(200).json({
        documents: documents.map(toDocumentDto),
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

  return router;
}
