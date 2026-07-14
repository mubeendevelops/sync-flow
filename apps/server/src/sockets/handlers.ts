/**
 * Doc-room event handlers: the client↔server protocol for one connected socket.
 *
 * Per-op edit pipeline (server-authoritative-ish relay, never a dumb relay):
 *   validate shape → authorize (editor) → rate-limit → applyRemote to the shared
 *   materialized CRDT → persist (batched) → broadcast to the rest of the room → ack.
 *
 * Trust boundaries: the room is the document context (ops carry no doc id we trust),
 * the authenticated `socket.data.user.id` is what gets persisted (never the client's
 * `authorId`), and a viewer's edits are rejected here — the client is never trusted
 * to enforce read-only.
 */

import { z } from "zod";
import type { Socket } from "socket.io";
import { applyRemote, type Op } from "@sync-flow/crdt";
import type { DbClient } from "../db/types.js";
import { AppError } from "../errors/app-error.js";
import { assertCanAccess } from "../documents/permissions.js";
import {
  getOperationsAfter,
  type DocumentStore,
  type DocumentStoreLogger,
} from "../crdt-service/index.js";
import { DocumentRoomManager } from "./room-manager.js";
import { parseEditPayload } from "./op-schema.js";
import { respondError } from "./errors.js";
import type { PeerOpRelay } from "./peer-relay.js";
import {
  listPresence,
  removePresence,
  setPresence,
  touchPresence,
  type PresenceCache,
} from "./presence.js";
import type {
  Ack,
  ClientToServerEvents,
  CursorPayload,
  EditPayload,
  InterServerEvents,
  JoinPayload,
  JoinResult,
  PresenceUser,
  ServerToClientEvents,
  SocketData,
  SyncPayload,
  SyncResult,
} from "./types.js";

export type DocSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface DocHandlerDeps {
  readonly db: DbClient;
  readonly manager: DocumentRoomManager;
  readonly presence: PresenceCache;
  readonly logger?: DocumentStoreLogger;
  /** Gap (ops) above which `sync` ships a full snapshot instead of the op tail. Default 500. */
  readonly syncThreshold?: number;
  /** Cross-instance peer-apply relay; omit for a single-instance/in-memory setup. */
  readonly peerRelay?: PeerOpRelay;
}

const DEFAULT_SYNC_THRESHOLD = 500;
const MAX_CURSOR_ID_LEN = 64;

const documentIdSchema = z.uuid();
const cursorPayloadSchema = z.object({
  anchor: z.string().max(MAX_CURSOR_ID_LEN).nullable(),
  head: z.string().max(MAX_CURSOR_ID_LEN).nullable(),
});
const syncPayloadSchema = z.object({ since: z.number().int().min(0) });

async function getUserPresenceInfo(
  db: DbClient,
  userId: string,
): Promise<{ displayName: string; color: string }> {
  const { rows } = await db.query<{ display_name: string; presence_color: string }>(
    "SELECT display_name, presence_color FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  return { displayName: row?.display_name ?? "Unknown", color: row?.presence_color ?? "#888888" };
}

export function registerDocHandlers(socket: DocSocket, deps: DocHandlerDeps): void {
  const { db, manager, presence, logger, peerRelay } = deps;
  const syncThreshold = deps.syncThreshold ?? DEFAULT_SYNC_THRESHOLD;

  // Per-socket state, established on `join`.
  let store: DocumentStore | null = null;
  let presenceUser: PresenceUser | null = null;

  socket.on("join", (payload: JoinPayload, ack: Ack<JoinResult>) => {
    void handleJoin(payload, ack);
  });
  socket.on("edit", (payload: EditPayload, ack) => {
    void handleEdit(payload, ack);
  });
  socket.on("cursor", (payload: CursorPayload) => {
    void handleCursor(payload);
  });
  socket.on("sync", (payload: SyncPayload, ack) => {
    void handleSync(payload, ack);
  });
  socket.on("disconnect", () => {
    void handleDisconnect();
  });

  async function handleJoin(payload: JoinPayload, ack: Ack<JoinResult>): Promise<void> {
    let acquired = false;
    let documentId: string | undefined;
    try {
      documentId = documentIdSchema.parse(payload?.documentId);
      if (socket.data.documentId) {
        throw AppError.badRequest("Already joined a document on this connection");
      }

      // Same authorization gate as REST — viewer may join read-only.
      const { role } = await assertCanAccess(db, socket.data.user.id, documentId, "viewer");

      store = await manager.acquire(documentId);
      acquired = true;
      socket.data.documentId = documentId;
      socket.data.role = role;
      await socket.join(documentId);

      const info = await getUserPresenceInfo(db, socket.data.user.id);
      presenceUser = {
        userId: socket.data.user.id,
        displayName: info.displayName,
        color: info.color,
        anchor: null,
        head: null,
      };
      await setPresence(presence, documentId, socket.id, presenceUser);
      socket.to(documentId).emit("user_joined", presenceUser);

      const users = await listPresence(presence, documentId);
      ack({
        ok: true,
        data: { role, snapshot: store.doc.toSnapshot(), seq: store.currentSeq, users },
      });
    } catch (err) {
      if (acquired && documentId) {
        manager.release(documentId);
        socket.data.documentId = undefined;
        socket.data.role = undefined;
        store = null;
        presenceUser = null;
      }
      respondError(socket, ack, err, logger);
    }
  }

  async function handleEdit(
    payload: EditPayload,
    ack: Ack<{ seq: number; count: number }>,
  ): Promise<void> {
    try {
      const documentId = socket.data.documentId;
      if (!documentId || !store) throw AppError.badRequest("Join a document before editing");
      if (socket.data.role !== "editor" && socket.data.role !== "owner") {
        throw AppError.forbidden("Requires editor access");
      }

      const ops = parseEditPayload(payload?.ops);
      // Rate-limit by op count so one client can't flood a document.
      if (!socket.data.rate.tryRemove(ops.length)) {
        throw AppError.tooManyRequests("Rate limit exceeded — slow down");
      }

      for (const op of ops) {
        const result = applyRemote(store.doc, op);
        // Persist anything that changed or was buffered for a later dependency; a
        // duplicate/no-op is already durable (or irrelevant), so skip the redundant row.
        if (result === "applied" || result === "buffered") {
          store.persist(op, socket.data.user.id);
        }
      }

      // Relay to everyone else in the room (this instance + peers via the Redis adapter).
      socket.to(documentId).emit("operation", { ops, seq: store.currentSeq });
      // Keep every OTHER instance's own materialized copy convergent too (peer-apply;
      // the socket relay above only reaches connected clients, not peer servers' stores).
      peerRelay?.publish(documentId, ops);
      await touchPresence(presence, documentId);

      ack({ ok: true, data: { seq: store.currentSeq, count: ops.length } });
    } catch (err) {
      respondError(socket, ack, err, logger);
    }
  }

  async function handleCursor(payload: CursorPayload): Promise<void> {
    try {
      const documentId = socket.data.documentId;
      if (!documentId || !presenceUser) return; // not joined — ignore
      // Cursor spam counts against the same bucket; drop silently when throttled.
      if (!socket.data.rate.tryRemove(1)) return;

      const { anchor, head } = cursorPayloadSchema.parse(payload);
      presenceUser = { ...presenceUser, anchor, head };
      await setPresence(presence, documentId, socket.id, presenceUser);
      socket.to(documentId).emit("cursor_update", presenceUser);
    } catch (err) {
      logger?.error({ err }, "cursor update failed");
    }
  }

  async function handleSync(payload: SyncPayload, ack: Ack<SyncResult>): Promise<void> {
    try {
      const documentId = socket.data.documentId;
      if (!documentId || !store) throw AppError.badRequest("Join a document before syncing");

      const { since } = syncPayloadSchema.parse(payload);
      const currentSeq = store.currentSeq;
      const gap = currentSeq - since;

      if (gap <= 0) {
        ack({ ok: true, data: { mode: "ops", ops: [], seq: currentSeq } });
        return;
      }
      if (gap <= syncThreshold) {
        const tail = await getOperationsAfter(db, documentId, since);
        const ops: Op[] = tail.map((r) => r.op);
        ack({ ok: true, data: { mode: "ops", ops, seq: currentSeq } });
        return;
      }
      // Too far behind: a fresh snapshot is cheaper than the op tail.
      ack({
        ok: true,
        data: { mode: "snapshot", snapshot: store.doc.toSnapshot(), seq: currentSeq },
      });
    } catch (err) {
      respondError(socket, ack, err, logger);
    }
  }

  async function handleDisconnect(): Promise<void> {
    const documentId = socket.data.documentId;
    if (!documentId) return;
    try {
      await removePresence(presence, documentId, socket.id);
      socket.to(documentId).emit("user_left", { userId: socket.data.user.id });
    } catch (err) {
      logger?.error({ err, documentId }, "presence cleanup failed on disconnect");
    } finally {
      // Always release the room ref so the store closes on last-client-disconnect.
      manager.release(documentId);
    }
  }
}
