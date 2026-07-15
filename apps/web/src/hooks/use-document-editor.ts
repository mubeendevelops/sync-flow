"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEditor, type Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Heading } from "@tiptap/extension-heading";
import { BulletList } from "@tiptap/extension-bullet-list";
import { OrderedList } from "@tiptap/extension-ordered-list";
import { ListItem } from "@tiptap/extension-list-item";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Link } from "@tiptap/extension-link";
import { HardBreak } from "@tiptap/extension-hard-break";
import type { DocumentSnapshot } from "@sync-flow/crdt";
import type { PublicUser } from "@sync-flow/schemas";
import { useWebSocket } from "@/hooks/use-websocket";
import { useCrdt } from "@/hooks/use-crdt";
import { RemoteCursors, setRemoteCursor, removeRemoteCursor } from "@/lib/remote-cursors";
import { dedupePresenceByUser, removePresence, upsertPresence } from "@/lib/presence";
import type { ConnectionState, JoinResult, PresenceUser } from "@/lib/websocket";

// prose-* below map to the `--tw-prose-*` custom properties configured in tailwind.config.ts,
// which in turn read our existing --foreground/--primary/etc HSL vars — so the editor already
// themes correctly in dark mode with no separate `prose-invert` class needed.
const EDITOR_CLASS =
  "prose dark:prose-invert max-w-none focus:outline-none " +
  "text-[18px] leading-[1.8] [&_p]:leading-[1.8]";

export interface UseDocumentEditorOptions {
  readonly documentId: string;
  readonly user: PublicUser | null;
  /** Connect only once auth is resolved and the user is known. */
  readonly enabled: boolean;
}

export interface UseDocumentEditorResult {
  readonly editor: Editor | null;
  readonly connectionState: ConnectionState;
  /** True while at least one edit ack is outstanding — drives the header's "Saving…" pill. */
  readonly isSaving: boolean;
  /** Users currently in the document (deduped by userId), for the header avatar stack. */
  readonly activeUsers: PresenceUser[];
  /** Latest "X joined" text for a screen-reader `aria-live="polite"` region — the toast covers
   * sighted users, this covers everyone else. Empty until the first join. */
  readonly joinAnnouncement: string;
}

/**
 * Wires TipTap to the shared RGA CRDT (`@sync-flow/crdt`) over the document WebSocket, making
 * the editor collaborative: local edits mint CRDT ops (applied instantly, broadcast async),
 * remote ops are integrated and reconciled back into the editor, carets stay stable, and
 * edits made while offline are buffered and replayed on reconnect.
 *
 * TipTap's own History extension is intentionally absent — undo/redo is COLLABORATIVE and
 * server-driven (per-user stacks in Redis): Mod-Z / Mod-Shift-Z emit `undo`/`redo` over the
 * socket and the resulting inverse ops come back through the normal remote-op path.
 */
export function useDocumentEditor(options: UseDocumentEditorOptions): UseDocumentEditorResult {
  const { documentId, user, enabled } = options;

  // Latest-value refs so the editor's static callbacks (created once, never recreated)
  // reach the current hook instances. Assigned in an effect, read only from callbacks.
  const crdtRef = useRef<ReturnType<typeof useCrdt> | null>(null);
  const wsRef = useRef<ReturnType<typeof useWebSocket> | null>(null);
  // A join snapshot that arrived before the editor's view was ready to receive it.
  const pendingSnapshotRef = useRef<DocumentSnapshot | null>(null);

  // Live presence (who's currently in the doc), driven by join/leave only — never by cursor
  // moves — so the header avatar stack doesn't re-render on every remote keystroke.
  const [activeUsers, setActiveUsers] = useState<PresenceUser[]>([]);
  const [joinAnnouncement, setJoinAnnouncement] = useState("");
  const selfId = user?.id;

  const editor = useEditor({
    immediatelyRender: false,
    // Fail-safe default: the editor mounts READ-ONLY and is only switched to editable once the
    // caller has confirmed this user's role can edit (the page's `setEditable(canEdit)` effect).
    // This closes the window where a viewer could type in the instant between the editor
    // mounting and their role resolving. The server is the real enforcement point regardless
    // (a viewer's `edit` is rejected there); this is defense-in-depth on the client.
    editable: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Heading.configure({ levels: [1, 2, 3] }),
      BulletList,
      OrderedList,
      ListItem,
      Code,
      CodeBlock,
      Link.configure({ openOnClick: false, autolink: true }),
      HardBreak,
      RemoteCursors,
    ],
    editorProps: {
      attributes: {
        class: EDITOR_CLASS,
        "aria-label": "Document content",
      },
      // Undo/redo are collaborative WS events, not local history.
      handleKeyDown: (view, event) => {
        // A read-only (viewer) editor emits no editing events at all — Ctrl+Z/Y do nothing.
        if (!view.editable) return false;
        const mod = event.metaKey || event.ctrlKey;
        if (!mod) return false;
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          wsRef.current?.sendUndo();
          return true;
        }
        if ((key === "z" && event.shiftKey) || key === "y") {
          wsRef.current?.sendRedo();
          return true;
        }
        return false;
      },
    },
    onUpdate: () => crdtRef.current?.onLocalChange(),
    onSelectionUpdate: () => crdtRef.current?.onLocalSelectionChange(),
  });

  // ---- Transport ----------------------------------------------------------------
  function applyPeerCursor(peer: PresenceUser): void {
    if (!editor || peer.userId === selfId) return;
    // Resolve the peer's (anchor, head) CRDT ids to live positions; null → no caret to draw.
    const sel = crdtRef.current?.resolveRemoteSelection(peer.anchor, peer.head) ?? null;
    if (!sel) {
      removeRemoteCursor(editor, peer.userId);
      return;
    }
    setRemoteCursor(editor, peer.userId, sel.anchor, sel.head, peer.color, peer.displayName);
  }

  function hydrateWhenReady(snapshot: DocumentSnapshot): void {
    if (editor?.view) crdtRef.current?.hydrate(snapshot);
    else pendingSnapshotRef.current = snapshot;
  }

  const ws = useWebSocket(documentId, enabled, {
    onJoined: (result: JoinResult, isReconnect: boolean) => {
      if (!isReconnect) hydrateWhenReady(result.snapshot);
      // Reset the presence roster to exactly who the server says is here.
      setActiveUsers(dedupePresenceByUser(result.users));
      // Paint whoever is already here (their last-known carets/selections).
      for (const peer of result.users) applyPeerCursor(peer);
    },
    onOperation: (ops) => crdtRef.current?.applyRemoteOps(ops),
    onCursorUpdate: (peer) => applyPeerCursor(peer),
    onUserJoined: (peer) => {
      let isNew = false;
      setActiveUsers((prev) => {
        isNew = !prev.some((u) => u.userId === peer.userId);
        return upsertPresence(prev, peer);
      });
      // Toast (sighted users) + aria-live region (screen readers) only for genuinely new
      // participants other than ourselves (a second own tab dedupes to the same userId and
      // shouldn't announce "you joined").
      if (isNew && peer.userId !== selfId) {
        toast(`${peer.displayName} joined`, { duration: 3000 });
        setJoinAnnouncement(`${peer.displayName} joined`);
      }
      applyPeerCursor(peer);
    },
    onUserLeft: (userId) => {
      setActiveUsers((prev) => removePresence(prev, userId));
      if (editor) removeRemoteCursor(editor, userId);
    },
    onAuthExpired: () => {
      // The socket layer silently refreshes + reconnects; nothing to do here for v1.
    },
  });

  // ---- CRDT ---------------------------------------------------------------------
  const crdt = useCrdt({
    editor,
    authorId: user?.id ?? "",
    sendOps: ws.sendEdit,
    sendCursor: ws.sendCursor,
  });

  // Keep the latest-value refs current for the editor's static callbacks.
  useEffect(() => {
    crdtRef.current = crdt;
    wsRef.current = ws;
  });

  // Flush a snapshot that beat the editor's view to the punch.
  useEffect(() => {
    if (editor?.view && pendingSnapshotRef.current) {
      crdt.hydrate(pendingSnapshotRef.current);
      pendingSnapshotRef.current = null;
    }
  }, [editor, crdt]);

  return {
    editor,
    connectionState: ws.connectionState,
    isSaving: ws.isSaving,
    activeUsers,
    joinAnnouncement,
  };
}
