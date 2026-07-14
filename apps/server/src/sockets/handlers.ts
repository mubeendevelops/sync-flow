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
import { applyRemote, encodeId, type Op } from "@sync-flow/crdt";
import type { DbClient } from "../db/types.js";
import { AppError } from "../errors/app-error.js";
import { assertCanAccess } from "../documents/permissions.js";
import {
  getOperationsAfter,
  getReplayFloor,
  type DocumentStore,
  type DocumentStoreLogger,
} from "../crdt-service/index.js";
import { DocumentRoomManager } from "./room-manager.js";
import { parseEditPayload } from "./op-schema.js";
import { respondError } from "./errors.js";
import type { PeerOpRelay } from "./peer-relay.js";
import {
  recordEdit,
  popUndo,
  popRedo,
  pushUndo,
  pushRedo,
  type UndoStackCache,
  type UndoOpRecord,
} from "./undo-stack.js";
import { applyUndoEntry, type UndoDirection } from "./undo-service.js";
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
  /**
   * Redis-backed per-user undo/redo stacks. Omit to disable undo/redo (the events then
   * reject with 501); edits still work, they just aren't recorded for undo.
   */
  readonly undoStack?: UndoStackCache;
  /**
   * How often a joined socket refreshes its document's presence TTL purely by being
   * connected, independent of edit/cursor activity. Default 20s (see
   * `DEFAULT_HEARTBEAT_INTERVAL_MS` — a third of `PRESENCE_TTL_SECONDS`, so at least
   * two heartbeats are missed before a live-but-idle viewer would ever expire).
   */
  readonly heartbeatIntervalMs?: number;
}

/**
 * "Too far behind" — the gap (in ops) above which `sync` sends a full snapshot instead
 * of the op tail. 500 = 5× the 100-op snapshot cadence (PLAN: snapshot every 100 ops).
 *
 * Rationale: a client within 500 ops of HEAD missed at most ~5 snapshot windows, so the
 * op tail is small, bounded, and trivial for the CRDT to replay. Beyond that, two costs
 * grow without a clean bound — the unpaginated `getOperationsAfter` read and the JSON op
 * payload on the wire — while a single snapshot is bounded by the CURRENT doc size
 * (visible chars + un-GC'd tombstones), which is the more predictable transfer. This is a
 * pure bandwidth/latency tradeoff, never a correctness one: both modes converge, so the
 * exact number is tunable (`syncThreshold` dep) without touching the protocol.
 */
const DEFAULT_SYNC_THRESHOLD = 500;
const MAX_CURSOR_ID_LEN = 64;

/**
 * Presence TTL (`PRESENCE_TTL_SECONDS`, 60s) is a dead-man's switch on the whole
 * per-document Redis hash, refreshed today only by activity (`touchPresence` on
 * edit, `setPresence` on cursor move). A connected-but-idle participant — someone
 * who just has the doc open and is reading, not typing or moving their cursor —
 * would silently fall out of presence after 60s even though their socket is still
 * open. A per-connection heartbeat, independent of activity, closes that gap: as
 * long as ANY joined socket is alive, the hash stays alive. 20s = a third of the
 * TTL, so at least two heartbeats can be missed (a slow tick, a GC pause) before
 * a live connection would ever expire.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

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
  const { db, manager, presence, logger, peerRelay, undoStack } = deps;
  const syncThreshold = deps.syncThreshold ?? DEFAULT_SYNC_THRESHOLD;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  // Per-socket state, established on `join`.
  let store: DocumentStore | null = null;
  let presenceUser: PresenceUser | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function startHeartbeat(documentId: string): void {
    heartbeat = setInterval(() => {
      void touchPresence(presence, documentId).catch((err: unknown) =>
        logger?.error({ err, documentId }, "presence heartbeat failed"),
      );
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

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
  socket.on("undo", (ack) => {
    void handleUndoRedo("undo", ack);
  });
  socket.on("redo", (ack) => {
    void handleUndoRedo("redo", ack);
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
      startHeartbeat(documentId);

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

      // Record only the ops that actually changed state (or will, once a dependency
      // lands) as this edit's undoable unit — a stale/duplicate op has nothing to undo.
      const undoRecords: UndoOpRecord[] = [];
      for (const op of ops) {
        const result = applyRemote(store.doc, op);
        // Persist anything that changed or was buffered for a later dependency; a
        // duplicate/no-op is already durable (or irrelevant), so skip the redundant row.
        if (result === "applied" || result === "buffered") {
          store.persist(op, socket.data.user.id);
          // `edit` only carries insert/delete (op-schema); the guard also narrows the type.
          if (op.type === "insert" || op.type === "delete") {
            undoRecords.push({ type: op.type, charId: encodeId(op.charId) });
          }
        }
      }

      // Relay to everyone else in the room (this instance + peers via the Redis adapter).
      socket.to(documentId).emit("operation", { ops, seq: store.currentSeq });
      // Keep every OTHER instance's own materialized copy convergent too (peer-apply;
      // the socket relay above only reaches connected clients, not peer servers' stores).
      peerRelay?.publish(documentId, ops);
      await touchPresence(presence, documentId);

      // One edit event = one undo unit; pushing it also clears this user's redo stack.
      // Await so an immediately-following undo is guaranteed to see it.
      if (undoStack) {
        await recordEdit(undoStack, documentId, socket.data.user.id, { ops: undoRecords });
      }

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

  /**
   * Catch a reconnected/behind client up (the DOWNLOAD half of resync). `since` is the
   * client's `last_known_version`. The UPLOAD half — offline local ops the client made
   * while disconnected — comes back up the normal `edit` path (validated, authorized,
   * persisted, rebroadcast), so a full reconnect is: `sync` down, then `edit` up. Order
   * doesn't matter for convergence (CRDT), but down-then-up keeps the client's own ops
   * layered on top of what it missed.
   */
  async function handleSync(payload: SyncPayload, ack: Ack<SyncResult>): Promise<void> {
    try {
      const documentId = socket.data.documentId;
      if (!documentId || !store) throw AppError.badRequest("Join a document before syncing");

      const { since } = syncPayloadSchema.parse(payload);
      const currentSeq = store.currentSeq;

      // (1) Client is AHEAD of the server: its last_known_version exceeds our durable
      //     watermark, so the server lost ops it can't reproduce (see Decision Log for
      //     why this is rare given optimistic acks carry the PERSISTED watermark, and
      //     what still triggers it — e.g. a Postgres PITR/restore rollback). We have no
      //     tail/snapshot worth sending (we're behind); tell the client to re-push its
      //     local ops via `edit`. Idempotent re-integration restores what we lost and
      //     no-ops the rest.
      if (since > currentSeq) {
        ack({ ok: true, data: { mode: "server_behind", seq: currentSeq } });
        return;
      }

      // (2) Already current.
      const gap = currentSeq - since;
      if (gap === 0) {
        ack({ ok: true, data: { mode: "ops", ops: [], seq: currentSeq } });
        return;
      }

      // (3) Below the replay floor (ops the client needs may have been pruned by
      //     retention) OR too far behind by size — a full snapshot is the complete,
      //     bounded answer. The replay-floor check is what makes "its version is older
      //     than our oldest retained op" correct rather than best-effort.
      const replayFloor = await getReplayFloor(db, documentId);
      if (since < replayFloor || gap > syncThreshold) {
        ack({
          ok: true,
          data: { mode: "snapshot", snapshot: store.doc.toSnapshot(), seq: currentSeq },
        });
        return;
      }

      // (4) Serve the op tail. All ops after `since` are guaranteed retained here.
      const tail = await getOperationsAfter(db, documentId, since);
      const ops: Op[] = tail.map((r) => r.op);
      ack({ ok: true, data: { mode: "ops", ops, seq: currentSeq } });
    } catch (err) {
      respondError(socket, ack, err, logger);
    }
  }

  /**
   * Collaborative undo/redo. Pops the caller's OWN per-document stack, mints the
   * inverse (undo) or forward (redo) ops — always visibility toggles of existing char
   * ids (delete/revive), never re-inserts — applies + persists them, and broadcasts to
   * the WHOLE room including the caller (unlike `edit`, the caller didn't apply these
   * locally). Each user's stacks are independent, so two users' undos never interact.
   * An empty stack acks silently with `applied: 0`.
   */
  async function handleUndoRedo(direction: UndoDirection, ack: Ack<{ applied: number; seq: number }>): Promise<void> {
    try {
      const documentId = socket.data.documentId;
      if (!documentId || !store) throw AppError.badRequest("Join a document before undo/redo");
      if (socket.data.role !== "editor" && socket.data.role !== "owner") {
        throw AppError.forbidden("Requires editor access");
      }
      if (!undoStack) throw AppError.notImplemented("Undo/redo is not available on this server");

      const userId = socket.data.user.id;
      const entry =
        direction === "undo"
          ? await popUndo(undoStack, documentId, userId)
          : await popRedo(undoStack, documentId, userId);

      // Nothing to undo/redo — silent no-op (edge case: also covers an insert the other
      // side already deleted, since applying the inverse below is idempotent).
      if (!entry) {
        ack({ ok: true, data: { applied: 0, seq: store.currentSeq } });
        return;
      }

      const ops = applyUndoEntry(store, entry, direction, userId);

      // Broadcast to everyone in the room INCLUDING the caller (they didn't apply these
      // locally), across instances via the adapter; keep peer stores convergent too.
      socket.nsp.to(documentId).emit("operation", { ops, seq: store.currentSeq });
      peerRelay?.publish(documentId, ops);
      await touchPresence(presence, documentId);

      // Undo → the entry becomes redoable; redo → it becomes undoable again. Neither
      // clears the opposite stack (only a fresh `edit` clears redo).
      if (direction === "undo") {
        await pushRedo(undoStack, documentId, userId, entry);
      } else {
        await pushUndo(undoStack, documentId, userId, entry);
      }

      ack({ ok: true, data: { applied: ops.length, seq: store.currentSeq } });
    } catch (err) {
      respondError(socket, ack, err, logger);
    }
  }

  async function handleDisconnect(): Promise<void> {
    const documentId = socket.data.documentId;
    if (!documentId) return;
    stopHeartbeat();
    try {
      await removePresence(presence, documentId, socket.id);
      // The same user may have the document open in another tab (a separate socket,
      // its own presence entry keyed by socket id). Only announce a real departure
      // once every one of their sessions on this document is gone — otherwise
      // closing tab A would wrongly tell everyone the user left while tab B is
      // still there, editing.
      const remaining = await listPresence(presence, documentId);
      const stillPresent = remaining.some((u) => u.userId === socket.data.user.id);
      if (!stillPresent) {
        socket.to(documentId).emit("user_left", { userId: socket.data.user.id });
      }
    } catch (err) {
      logger?.error({ err, documentId }, "presence cleanup failed on disconnect");
    } finally {
      // Always release the room ref so the store closes on last-client-disconnect.
      manager.release(documentId);
    }
  }
}
