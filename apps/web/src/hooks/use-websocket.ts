"use client";

/**
 * Owns the realtime connection for one document: opens a {@link CollabSocket}, (re)joins
 * the room on every connect, and buffers outbound edits while offline so a network blip
 * never drops a keystroke.
 *
 * Reconnect flow (the offline-resync contract from CLAUDE.md): on a *re*join we first
 * `sync(lastKnownSeq)` to download whatever we missed (the DOWNLOAD half), then flush the
 * outbound queue via `edit` (the UPLOAD half). Order is down-then-up so our own offline
 * ops layer on top of what we missed; convergence itself is order-independent (CRDT).
 *
 * Handlers are held in a ref so a parent re-render never tears down the socket — the
 * effect re-runs only when the document or the enabled flag changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Op } from "@sync-flow/crdt";
import {
  CollabSocket,
  resolveSocketUrl,
  SocketRequestError,
  type ConnectionState,
  type JoinResult,
  type PresenceUser,
} from "@/lib/websocket";

export interface UseWebSocketHandlers {
  /** Fired on every successful (re)join. `isReconnect` is false only for the first join. */
  onJoined: (result: JoinResult, isReconnect: boolean) => void;
  /** Remote ops to integrate — live broadcasts and the `sync` catch-up tail alike. */
  onOperation: (ops: Op[], seq: number) => void;
  onCursorUpdate?: (user: PresenceUser) => void;
  onUserJoined?: (user: PresenceUser) => void;
  onUserLeft?: (userId: string) => void;
  onAuthExpired?: () => void;
}

export interface UseWebSocketResult {
  connectionState: ConnectionState;
  /** True while at least one `edit` ack is outstanding — drives the header's "Saving…" pill. */
  isSaving: boolean;
  /** Send local ops now, or queue them if offline (they're already applied locally). */
  sendEdit: (ops: Op[]) => void;
  /** Broadcast this replica's selection as CRDT anchor/head ids (fire-and-forget). */
  sendCursor: (anchor: string | null, head: string | null) => void;
  /** Ask the server for everything since our last known seq and apply the tail. */
  requestSync: () => Promise<void>;
  sendUndo: () => void;
  sendRedo: () => void;
}

export function useWebSocket(
  documentId: string,
  enabled: boolean,
  handlers: UseWebSocketHandlers,
): UseWebSocketResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  // Count of in-flight `edit` acks (not queued-while-offline ops, which aren't "saving" yet —
  // there's nothing in flight to wait on). Read via a snapshot-friendly boolean state. Not
  // explicitly reset on a doc switch: any edit still in flight from the old session settles
  // (resolves/rejects, each socket request has a 10s ack timeout) and decrements it normally,
  // so `isSaving` self-corrects without needing a render-time reset.
  const inFlightEditsRef = useRef(0);
  const [isSaving, setIsSaving] = useState(false);

  const beginSave = useCallback(() => {
    inFlightEditsRef.current += 1;
    setIsSaving(true);
  }, []);

  const endSave = useCallback(() => {
    inFlightEditsRef.current = Math.max(0, inFlightEditsRef.current - 1);
    if (inFlightEditsRef.current === 0) setIsSaving(false);
  }, []);

  // Latest handlers, read only from socket callbacks (which fire after commit) — kept
  // current via an effect so the socket effect never re-runs just because a handler's
  // identity changed on a parent re-render.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const socketRef = useRef<CollabSocket | null>(null);
  const lastSeqRef = useRef(0);
  const hasJoinedRef = useRef(false);
  /** Edits made while not connected, awaiting a flush on reconnect. Each entry is one batch. */
  const outboundQueueRef = useRef<Op[][]>([]);

  const noteSeq = useCallback((seq: number) => {
    if (seq > lastSeqRef.current) lastSeqRef.current = seq;
  }, []);

  const requestSync = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket || !socket.isConnected()) return;
    const result = await socket.sync(lastSeqRef.current);
    noteSeq(result.seq);
    if (result.mode === "ops" && result.ops.length > 0) {
      handlersRef.current.onOperation(result.ops, result.seq);
    }
    // 'snapshot' / 'server_behind' mean we're too far behind the replay floor to catch up
    // with a tail; we keep local state and re-push our queued ops below. A full reload is
    // the recovery path for that rare case (see PLAN.md offline limitation note).
  }, [noteSeq]);

  const flushOutbound = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || !socket.isConnected()) return;
    const batches = outboundQueueRef.current;
    outboundQueueRef.current = [];
    for (const ops of batches) {
      beginSave();
      socket.edit(ops).then(
        (r) => {
          noteSeq(r.seq);
          endSave();
        },
        (err) => {
          endSave();
          if (err instanceof SocketRequestError) {
            // The server explicitly rejected this batch (e.g. access was revoked while
            // offline) — retrying it forever would spin uselessly, so drop it and say so.
            toast.error("Some offline edits couldn't be saved — you may no longer have access.");
            return;
          }
          // A transient/network failure — re-queue so the next reconnect retries it.
          outboundQueueRef.current.push(ops);
        },
      );
    }
  }, [noteSeq, beginSave, endSave]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    hasJoinedRef.current = false;
    const socket = new CollabSocket(resolveSocketUrl(), {
      onStateChange: setConnectionState,
      onOperation: (ops, seq) => {
        noteSeq(seq);
        handlersRef.current.onOperation(ops, seq);
      },
      onCursorUpdate: (user) => handlersRef.current.onCursorUpdate?.(user),
      onUserJoined: (user) => handlersRef.current.onUserJoined?.(user),
      onUserLeft: (userId) => handlersRef.current.onUserLeft?.(userId),
      onAuthExpired: () => handlersRef.current.onAuthExpired?.(),
      onServerError: (payload) => toast.error(payload.message),
    });
    socketRef.current = socket;

    // Join (and, after a reconnect, resync + flush) on every fresh connection.
    const joinOnConnect = () => {
      void (async () => {
        try {
          const result = await socket.join(documentId);
          noteSeq(result.seq);
          const isReconnect = hasJoinedRef.current;
          hasJoinedRef.current = true;
          handlersRef.current.onJoined(result, isReconnect);
          if (isReconnect) {
            await requestSync();
            flushOutbound();
          }
        } catch {
          // A failed join (e.g. transient auth refresh mid-upgrade) is retried on the
          // next 'connect'; state stays non-`connected`, so edits keep queueing.
        }
      })();
    };
    socket.onConnect(joinOnConnect);

    return () => {
      socket.destroy();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, enabled]);

  const sendEdit = useCallback(
    (ops: Op[]) => {
      if (ops.length === 0) return;
      const socket = socketRef.current;
      if (socket && socket.isConnected()) {
        beginSave();
        socket.edit(ops).then(
          (r) => {
            if (r.seq > lastSeqRef.current) lastSeqRef.current = r.seq;
            endSave();
          },
          (err) => {
            endSave();
            if (err instanceof SocketRequestError) {
              toast.error("Couldn't save your last edit — you may no longer have access.");
              return;
            }
            outboundQueueRef.current.push(ops);
          },
        );
      } else {
        outboundQueueRef.current.push(ops);
      }
    },
    [beginSave, endSave],
  );

  const sendCursor = useCallback((anchor: string | null, head: string | null) => {
    socketRef.current?.cursor(anchor, head);
  }, []);

  const sendUndo = useCallback(() => {
    socketRef.current?.undo().then(
      (r) => {
        if (r.seq > lastSeqRef.current) lastSeqRef.current = r.seq;
      },
      () => toast.error("Couldn't undo. Please try again."),
    );
  }, []);

  const sendRedo = useCallback(() => {
    socketRef.current?.redo().then(
      (r) => {
        if (r.seq > lastSeqRef.current) lastSeqRef.current = r.seq;
      },
      () => toast.error("Couldn't redo. Please try again."),
    );
  }, []);

  return { connectionState, isSaving, sendEdit, sendCursor, requestSync, sendUndo, sendRedo };
}
