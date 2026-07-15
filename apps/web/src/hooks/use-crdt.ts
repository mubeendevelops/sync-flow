"use client";

/**
 * Owns the client-side CRDT document for one editor. The `RGADocument` lives in a REF, not
 * React state, on purpose: a remote keystroke must not re-render the editor tree — the
 * bridge applies it straight into ProseMirror. The hook builds the doc + bridge on hydrate
 * (from the server's join snapshot) and exposes the bridge's interface to the transport.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { type Op, type DocumentSnapshot, RGADocument, cursorToIndex, decodeId } from "@sync-flow/crdt";
import {
  createCrdtBridge,
  hydrateDocument,
  indexToPmPos,
  type CrdtBridge,
} from "@/lib/crdt-bridge";

export interface UseCrdtParams {
  readonly editor: Editor | null;
  readonly authorId: string;
  readonly sendOps: (ops: Op[]) => void;
  readonly sendCursor: (anchor: string | null, head: string | null) => void;
  /**
   * Shared handle with the slash-command extension. While its `active` flag is set, the bridge
   * suppresses op emission (the `/` + filter text stays local UI); its `onDismiss` is pointed at
   * the current bridge's `onLocalChange` so a menu close reconciles the editor into the CRDT.
   */
  readonly slashController?: { active: boolean; onDismiss?: () => void };
}

export interface UseCrdtResult {
  /** This tab's replica id (per CLAUDE.md, minted once per browser tab). */
  readonly replicaId: string;
  /** (Re)build the doc + bridge from a snapshot and mirror it into the editor. */
  readonly hydrate: (snapshot: DocumentSnapshot) => void;
  /** Integrate remote ops and reconcile the editor (stable identity). */
  readonly applyRemoteOps: (ops: Op[]) => void;
  /** For the editor's `onUpdate`. */
  readonly onLocalChange: () => void;
  /** For the editor's `onSelectionUpdate`. */
  readonly onLocalSelectionChange: () => void;
  /**
   * Map a peer's encoded (anchor, head) CRDT char ids to live ProseMirror positions.
   * Returns null when neither id resolves (the peer has no cursor to draw).
   */
  readonly resolveRemoteSelection: (
    anchorId: string | null,
    headId: string | null,
  ) => { anchor: number; head: number } | null;
}

export function useCrdt(params: UseCrdtParams): UseCrdtResult {
  const { editor, authorId, sendOps, sendCursor, slashController } = params;

  // Minted once per tab (lazy state, not a ref, so it's stable without a render-time read).
  const [replicaId] = useState(() => crypto.randomUUID());

  const docRef = useRef<RGADocument | null>(null);
  const bridgeRef = useRef<CrdtBridge | null>(null);

  const hydrate = useCallback(
    (snapshot: DocumentSnapshot) => {
      if (!editor) return;
      // Tear down a prior bridge (e.g. a re-hydrate) so its throttled cursor timer is cancelled.
      bridgeRef.current?.destroy();
      const doc = hydrateDocument(snapshot, { replicaId, authorId });
      docRef.current = doc;
      bridgeRef.current = createCrdtBridge({
        editor,
        doc,
        replicaId,
        sendOps,
        sendCursor,
        // While the slash menu is open, suppress op emission so the `/` + filter text stays
        // local UI (the menu's own `onDismiss` flushes the final state via `onLocalChange`).
        isSuppressed: slashController ? () => slashController.active : undefined,
      });
      bridgeRef.current.syncEditorFromDoc();
    },
    [editor, replicaId, authorId, sendOps, sendCursor, slashController],
  );

  // Cancel the bridge's pending cursor timer when the hook unmounts.
  useEffect(() => () => bridgeRef.current?.destroy(), []);

  const applyRemoteOps = useCallback((ops: Op[]) => {
    bridgeRef.current?.applyRemoteOps(ops);
  }, []);

  const onLocalChange = useCallback(() => {
    bridgeRef.current?.onLocalChange();
  }, []);

  const onLocalSelectionChange = useCallback(() => {
    bridgeRef.current?.onLocalSelectionChange();
  }, []);

  const resolveRemoteSelection = useCallback(
    (anchorId: string | null, headId: string | null): { anchor: number; head: number } | null => {
      const doc = docRef.current;
      if (!doc || !editor) return null;
      if (anchorId === null && headId === null) return null;

      const resolve = (encoded: string): number => {
        const index = cursorToIndex(doc, { after: decodeId(encoded) });
        return Math.min(indexToPmPos(editor.state.doc, index), editor.state.doc.content.size);
      };
      // Fall back each side to the other so a half-specified selection still draws a caret.
      const head = resolve(headId ?? anchorId!);
      const anchor = resolve(anchorId ?? headId!);
      return { anchor, head };
    },
    [editor],
  );

  return {
    replicaId,
    hydrate,
    applyRemoteOps,
    onLocalChange,
    onLocalSelectionChange,
    resolveRemoteSelection,
  };
}
