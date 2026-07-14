/**
 * Wire contracts + `socket.data` shape for the real-time layer. The Socket.io server
 * is generically typed with these so handler payloads and emits are checked, not `any`.
 */

import type { Op, DocumentSnapshot } from "@sync-flow/crdt";
import type { DocumentRole } from "../documents/permissions.js";
import type { TokenBucket } from "./rate-limit.js";

/** A participant's live presence (ephemeral — Redis TTL, never Postgres). */
export interface PresenceUser {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  /** Encoded char id the selection anchor sits after, or null (no cursor yet). */
  readonly anchor: string | null;
  readonly head: string | null;
}

export interface JoinPayload {
  readonly documentId: string;
}

export interface EditPayload {
  readonly ops: unknown; // validated by op-schema into Op[]
}

export interface CursorPayload {
  readonly anchor: string | null;
  readonly head: string | null;
}

export interface SyncPayload {
  /**
   * The client's `last_known_version` — the highest server-assigned `seq` it has
   * durably observed (via an edit ack, an `operation` broadcast, or a prior
   * join/sync). The server catches the client up from here. Named `since` on the
   * wire (this is a "give me everything since X" request); it IS last_known_version.
   */
  readonly since: number;
}

export interface JoinResult {
  readonly role: DocumentRole;
  readonly snapshot: DocumentSnapshot;
  readonly seq: number;
  readonly users: PresenceUser[];
}

export interface EditResult {
  /** Server's latest known persisted watermark after this batch (a lower bound). */
  readonly seq: number;
  readonly count: number;
}

/**
 * Result of an `undo`/`redo`. `applied` is the number of forward ops emitted (0 when
 * the user's stack was empty — a silent no-op). The resulting ops arrive via the normal
 * `operation` broadcast, which for undo/redo includes the acting client itself (it did
 * not apply them locally).
 */
export interface UndoResult {
  readonly applied: number;
  readonly seq: number;
}

/**
 * Server's answer to a `sync`. `seq` is always the server's current durable
 * watermark, so the client can drive its "Reconnecting…/all changes saved" indicator
 * off it regardless of mode.
 *   - `ops`      — apply this catch-up tail, then advance to `seq`.
 *   - `snapshot` — the client is below the replay floor or too far behind: rebuild
 *                  the base from `snapshot`, then re-apply any still-unconfirmed local
 *                  ops on top (idempotent) and push them via `edit`.
 *   - `server_behind` — the client's `last_known_version` is AHEAD of the server
 *                  (`since > seq`): the server lost ops it can't reproduce. The client
 *                  keeps its state and re-pushes its local ops via `edit`; CRDT
 *                  idempotency restores what was lost and no-ops the rest. See the
 *                  handler + Decision Log for why this is rare-but-handled.
 */
export type SyncResult =
  | { readonly mode: "ops"; readonly ops: Op[]; readonly seq: number }
  | { readonly mode: "snapshot"; readonly snapshot: DocumentSnapshot; readonly seq: number }
  | { readonly mode: "server_behind"; readonly seq: number };

export interface SocketErrorPayload {
  /** HTTP-style status the client can branch on (401/403/404/400/429/500). */
  readonly code: number;
  readonly message: string;
}

/** Result envelope returned through a Socket.io ack callback. */
export type AckResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SocketErrorPayload };

export type Ack<T> = (result: AckResult<T>) => void;

export interface ClientToServerEvents {
  join: (payload: JoinPayload, ack: Ack<JoinResult>) => void;
  edit: (payload: EditPayload, ack: Ack<EditResult>) => void;
  cursor: (payload: CursorPayload) => void;
  sync: (payload: SyncPayload, ack: Ack<SyncResult>) => void;
  // Collaborative undo/redo: no payload — each acts on the caller's own per-doc stack.
  undo: (ack: Ack<UndoResult>) => void;
  redo: (ack: Ack<UndoResult>) => void;
}

export interface ServerToClientEvents {
  operation: (payload: { ops: Op[]; seq: number }) => void;
  cursor_update: (payload: PresenceUser) => void;
  user_joined: (payload: PresenceUser) => void;
  user_left: (payload: { userId: string }) => void;
  error: (payload: SocketErrorPayload) => void;
  "auth:expired": () => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  user: { id: string };
  /** Set once the socket has joined a doc room. */
  documentId?: string;
  role?: DocumentRole;
  rate: TokenBucket;
  /** Access-token expiry (epoch seconds) for the mid-session `auth:expired` timer. */
  tokenExp?: number;
}
