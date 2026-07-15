/**
 * The document WebSocket client: a thin, typed wrapper over socket.io-client that owns
 * one connection to the realtime server for one document.
 *
 * Auth is the httpOnly access-token cookie, read by the server on the HTTP upgrade
 * (see apps/server/src/sockets/authenticate.ts) — `withCredentials: true` sends it and
 * NO token ever appears in a query string. The server is websocket-only with CORS
 * credentials, so we pin `transports: ["websocket"]` to match.
 *
 * Reconnection is socket.io's built-in exponential backoff, configured to the spec'd
 * 100ms → …→ 30s ceiling. We map its lifecycle onto four coarse states the UI cares
 * about: `connecting` (pre-first-connect), `connected`, `reconnecting` (link lost, retry
 * in flight), and `offline` (a retry has already failed, or the browser reports offline).
 * The hook layer buffers outbound edits whenever we are not `connected` and flushes on
 * reconnect, so a blip never drops a keystroke.
 */

import { io, type Socket } from "socket.io-client";
import type { Op, DocumentSnapshot } from "@sync-flow/crdt";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

/** A participant's live presence, mirrored from the server's `PresenceUser`. */
export interface PresenceUser {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly anchor: string | null;
  readonly head: string | null;
}

export interface JoinResult {
  readonly role: "owner" | "editor" | "viewer";
  readonly snapshot: DocumentSnapshot;
  readonly seq: number;
  readonly users: PresenceUser[];
}

export type SyncResult =
  | { readonly mode: "ops"; readonly ops: Op[]; readonly seq: number }
  | { readonly mode: "snapshot"; readonly snapshot: DocumentSnapshot; readonly seq: number }
  | { readonly mode: "server_behind"; readonly seq: number };

export interface EditResult {
  readonly seq: number;
  readonly count: number;
}

export interface UndoResult {
  readonly applied: number;
  readonly seq: number;
}

export interface SocketErrorPayload {
  readonly code: number;
  readonly message: string;
}

type AckResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SocketErrorPayload };

/** Server→client event callbacks. All optional; wired by the hook. */
export interface SocketHandlers {
  onStateChange?: (state: ConnectionState) => void;
  onOperation?: (ops: Op[], seq: number) => void;
  onCursorUpdate?: (user: PresenceUser) => void;
  onUserJoined?: (user: PresenceUser) => void;
  onUserLeft?: (userId: string) => void;
  onAuthExpired?: () => void;
  /** The server's fire-and-forget `error` channel (used for events with no ack, e.g. a rejected
   * `cursor` emit) — never thrown, always routed through this callback. */
  onServerError?: (payload: SocketErrorPayload) => void;
}

/** Raised when an ack comes back `{ ok: false }` — carries the server's status code. */
export class SocketRequestError extends Error {
  readonly code: number;
  constructor(payload: SocketErrorPayload) {
    super(payload.message);
    this.name = "SocketRequestError";
    this.code = payload.code;
  }
}

/** How long to wait for an ack before rejecting, so a stalled flush can't hang forever. */
const ACK_TIMEOUT_MS = 10_000;

export class CollabSocket {
  private readonly socket: Socket;
  private state: ConnectionState = "connecting";
  private everConnected = false;

  constructor(
    url: string,
    private readonly handlers: SocketHandlers,
  ) {
    this.socket = io(url, {
      withCredentials: true,
      transports: ["websocket"],
      reconnection: true,
      // Exponential backoff: 100ms doubling up to a 30s ceiling (socket.io adds jitter).
      reconnectionDelay: 100,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      timeout: 20_000,
    });
    this.registerLifecycle();
    this.registerServerEvents();
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Register a callback fired on every successful connect — the first one and every
   * reconnect — so the caller can (re)join the room. Registered synchronously after
   * construction, before socket.io's async `connect` fires, so no connect is missed.
   */
  onConnect(cb: () => void): void {
    this.socket.on("connect", cb);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onStateChange?.(next);
  }

  private registerLifecycle(): void {
    this.socket.on("connect", () => {
      this.everConnected = true;
      this.setState("connected");
    });
    // Link dropped — socket.io begins retrying. Show "reconnecting" first; a failed
    // retry (`connect_error` below) escalates to "offline", at which point we buffer.
    this.socket.on("disconnect", () => {
      this.setState(this.everConnected ? "reconnecting" : "connecting");
    });
    this.socket.on("connect_error", () => {
      // A retry attempt just failed. If we had a working link, we're now genuinely
      // offline (keep retrying in the background); pre-first-connect stays "connecting".
      this.setState(this.everConnected ? "offline" : "connecting");
    });
    this.socket.io.on("reconnect_attempt", () => {
      if (this.state !== "offline") this.setState("reconnecting");
    });

    if (typeof window !== "undefined") {
      window.addEventListener("offline", this.handleBrowserOffline);
      window.addEventListener("online", this.handleBrowserOnline);
    }
  }

  private readonly handleBrowserOffline = (): void => {
    if (this.everConnected) this.setState("offline");
  };

  private readonly handleBrowserOnline = (): void => {
    // Nudge socket.io to retry immediately rather than waiting out the backoff.
    if (!this.socket.connected) this.socket.connect();
  };

  private registerServerEvents(): void {
    this.socket.on("operation", (payload: { ops: Op[]; seq: number }) => {
      this.handlers.onOperation?.(payload.ops, payload.seq);
    });
    this.socket.on("cursor_update", (user: PresenceUser) => {
      this.handlers.onCursorUpdate?.(user);
    });
    this.socket.on("user_joined", (user: PresenceUser) => {
      this.handlers.onUserJoined?.(user);
    });
    this.socket.on("user_left", (payload: { userId: string }) => {
      this.handlers.onUserLeft?.(payload.userId);
    });
    this.socket.on("auth:expired", () => {
      this.handlers.onAuthExpired?.();
    });
    this.socket.on("error", (payload: SocketErrorPayload) => {
      this.handlers.onServerError?.(payload);
    });
  }

  /** Emit an event that expects an ack, resolving its `data` or rejecting on error/timeout. */
  private request<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emit(event, payload, (timeoutErr: Error | null, result: AckResult<T>) => {
          if (timeoutErr) {
            reject(timeoutErr);
            return;
          }
          if (result.ok) resolve(result.data);
          else reject(new SocketRequestError(result.error));
        });
    });
  }

  join(documentId: string): Promise<JoinResult> {
    return this.request<JoinResult>("join", { documentId });
  }

  edit(ops: Op[]): Promise<EditResult> {
    return this.request<EditResult>("edit", { ops });
  }

  sync(since: number): Promise<SyncResult> {
    return this.request<SyncResult>("sync", { since });
  }

  undo(): Promise<UndoResult> {
    return this.requestNoPayload<UndoResult>("undo");
  }

  redo(): Promise<UndoResult> {
    return this.requestNoPayload<UndoResult>("redo");
  }

  /** Cursor updates are fire-and-forget (no ack) — dropped silently if not connected. */
  cursor(anchor: string | null, head: string | null): void {
    if (!this.socket.connected) return;
    this.socket.emit("cursor", { anchor, head });
  }

  private requestNoPayload<T>(event: "undo" | "redo"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emit(event, (timeoutErr: Error | null, result: AckResult<T>) => {
          if (timeoutErr) {
            reject(timeoutErr);
            return;
          }
          if (result.ok) resolve(result.data);
          else reject(new SocketRequestError(result.error));
        });
    });
  }

  destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("offline", this.handleBrowserOffline);
      window.removeEventListener("online", this.handleBrowserOnline);
    }
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

/**
 * Resolve the realtime server origin from env (WS url preferred, API url as fallback).
 * socket.io-client builds its endpoint from an http(s) origin even when the only transport
 * is websocket, so a `ws://`/`wss://` value is normalized back to `http(s)://`.
 */
export function resolveSocketUrl(): string {
  const url = process.env.NEXT_PUBLIC_WS_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_WS_URL (or NEXT_PUBLIC_API_URL) is not set");
  }
  return url.replace(/^ws(s?):\/\//, "http$1://");
}
