/**
 * The CRDT seam: the one interface TipTap and `@sync-flow/crdt` talk through. It keeps a
 * ProseMirror editor and an RGA document in lockstep through the flat plaintext projection
 * (see text-projection.ts), in both directions:
 *
 *   - onLocalChange: diff the editor's projection against the last known text, mint CRDT
 *     `localInsert`/`localDelete` ops (applied to the local doc instantly, so typing never
 *     waits on the network), and hand them to the transport to broadcast.
 *   - applyRemoteOps: integrate ops from other replicas into the local doc, then apply the
 *     MINIMAL ProseMirror transaction to bring the editor display back in line.
 *
 * Echo-loop prevention: a per-tab `replicaId` is our session nonce (CLAUDE.md mints one
 * per browser tab). Every op we author carries it — an insert in `charId.replicaId`, a
 * delete in `replicaId` — so we drop any inbound op stamped with our own id. The server
 * never relays our normal edits back to us anyway; this also makes the reconcile idempotent
 * against any at-least-once redelivery. Undo/redo ops are server-minted with a fresh UUID,
 * so they always pass this filter and are applied.
 *
 * Cursor stability: before applying a remote op we snapshot the caret as CRDT char ids;
 * after applying we resolve those ids back to positions in the re-indexed document and
 * restore the selection in the SAME transaction — the caret never jumps (transform.ts does
 * the id↔index remapping).
 */

import type { Editor } from "@tiptap/react";
import {
  type Op,
  type DocumentSnapshot,
  RGADocument,
  encodeId,
  decodeId,
  localInsert,
  localDelete,
  applyRemote,
  cursorFromIndex,
  cursorToIndex,
} from "@sync-flow/crdt";
import {
  docToText,
  diffText,
  buildRemoteTransaction,
  selectionToIndices,
  setSelectionFromIndices,
  indexToPmPos,
} from "@/lib/text-projection";

export interface CursorIds {
  readonly anchorId: string;
  readonly headId: string;
}

export interface CrdtBridgeOptions {
  readonly editor: Editor;
  readonly doc: RGADocument;
  /** This tab's replica id — the session nonce used to ignore our own echoed ops. */
  readonly replicaId: string;
  /** Broadcast locally-minted ops (transport decides connected-vs-queued). */
  readonly sendOps: (ops: Op[]) => void;
  /** Publish this replica's selection as encoded CRDT anchor/head ids. */
  readonly sendCursor: (anchor: string | null, head: string | null) => void;
}

export interface CrdtBridge {
  /** Replace the editor + `lastText` from the doc's current state (after hydrate/resync). */
  syncEditorFromDoc: () => void;
  /** TipTap `onUpdate`: diff the projection, mint + apply + broadcast local ops. */
  onLocalChange: () => void;
  /** TipTap `onSelectionUpdate`: publish the caret as CRDT ids (rAF-throttled to ~50ms). */
  onLocalSelectionChange: () => void;
  /** Integrate remote ops into the doc and reconcile the editor display. */
  applyRemoteOps: (ops: Op[]) => void;
  /** Cancel any pending throttled cursor send (call when tearing the bridge down). */
  destroy: () => void;
}

/**
 * Cursor broadcasts are throttled to at most one per this window, scheduled on the paint
 * cycle (requestAnimationFrame) so a burst of selection changes coalesces to a single send
 * per frame instead of flooding the socket while the user drags a selection.
 */
const CURSOR_THROTTLE_MS = 50;

export function createCrdtBridge(options: CrdtBridgeOptions): CrdtBridge {
  const { editor, doc, replicaId, sendOps, sendCursor } = options;

  // Mirror of the doc's plaintext, kept in sync on every local + remote change, so each
  // diff is against the exact previous projection rather than re-deriving from the doc.
  let lastText = docToText(editor.state.doc);
  // Set while we dispatch a transaction we built ourselves (hydrate/remote apply), so the
  // editor's `onUpdate` doesn't mistake it for a local edit and re-emit ops.
  let applying = false;

  function isOwnOp(op: Op): boolean {
    if (op.type === "insert") return op.charId.replicaId === replicaId;
    return op.replicaId === replicaId;
  }

  function getCursorIds(): CursorIds {
    const { anchor, head } = selectionToIndices(editor.state);
    return {
      anchorId: encodeId(cursorFromIndex(doc, anchor).after),
      headId: encodeId(cursorFromIndex(doc, head).after),
    };
  }

  function dispatchProgrammatic(build: () => void): void {
    applying = true;
    try {
      build();
    } finally {
      applying = false;
    }
  }

  function syncEditorFromDoc(): void {
    const text = doc.text();
    const schema = editor.schema;
    const paragraphs = text
      .split("\n")
      .map((line) =>
        schema.node("paragraph", null, line.length > 0 ? schema.text(line) : undefined),
      );
    const newDoc = schema.node("doc", null, paragraphs);
    dispatchProgrammatic(() => {
      const tr = editor.state.tr;
      tr.replaceWith(0, editor.state.doc.content.size, newDoc.content);
      tr.setMeta("addToHistory", false);
      editor.view.dispatch(tr);
    });
    lastText = text;
  }

  function onLocalChange(): void {
    if (applying) return;
    const newText = docToText(editor.state.doc);
    const diff = diffText(lastText, newText);
    if (!diff) return;

    const ops: Op[] = [];
    // Delete right-to-left so each removal leaves the lower indices untouched.
    for (let i = diff.from + diff.deleted - 1; i >= diff.from; i--) {
      ops.push(localDelete(doc, i));
    }
    // Insert left-to-right, one code unit per CRDT char.
    for (let k = 0; k < diff.inserted.length; k++) {
      ops.push(localInsert(doc, diff.from + k, diff.inserted[k]!));
    }

    lastText = newText;
    if (ops.length > 0) sendOps(ops);
  }

  // rAF-based throttle for outbound cursor broadcasts (see CURSOR_THROTTLE_MS). We read the
  // selection at *flush* time, so intermediate moves within a frame collapse into one send.
  let cursorRaf = 0;
  let lastCursorSentAt = 0;
  const hasRaf = typeof requestAnimationFrame !== "undefined";

  function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  function flushCursor(): void {
    cursorRaf = 0;
    // Not yet 50ms since the last send — re-arm for a later frame rather than sending early.
    if (now() - lastCursorSentAt < CURSOR_THROTTLE_MS) {
      cursorRaf = requestAnimationFrame(flushCursor);
      return;
    }
    lastCursorSentAt = now();
    const { anchorId, headId } = getCursorIds();
    sendCursor(anchorId, headId);
  }

  function onLocalSelectionChange(): void {
    if (applying) return;
    if (!hasRaf) {
      // SSR / non-browser fallback: send immediately (no paint cycle to sync to).
      const { anchorId, headId } = getCursorIds();
      sendCursor(anchorId, headId);
      return;
    }
    if (cursorRaf === 0) cursorRaf = requestAnimationFrame(flushCursor);
  }

  function destroy(): void {
    if (cursorRaf !== 0 && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(cursorRaf);
    }
    cursorRaf = 0;
  }

  /**
   * Integrates remote ops and reconciles the editor. Never throws: a malformed/failing op is
   * logged and skipped rather than aborting the batch, and any failure in reconciliation itself
   * is caught so a bad remote op can never crash the editor — the user keeps typing regardless.
   */
  function applyRemoteOps(ops: Op[]): void {
    try {
      const foreign = ops.filter((op) => !isOwnOp(op));
      if (foreign.length === 0) return;

      // Snapshot the caret as CRDT ids BEFORE the doc is re-indexed.
      const cursor = getCursorIds();

      for (const op of foreign) {
        try {
          applyRemote(doc, op);
        } catch (err) {
          console.error("Failed to apply remote CRDT op — skipping it", op, err);
        }
      }

      const newText = doc.text();
      const diff = diffText(docToText(editor.state.doc), newText);
      if (!diff) return; // pure duplicates/buffered — nothing visible changed.

      dispatchProgrammatic(() => {
        const tr = buildRemoteTransaction(editor.state, diff);
        // Resolve the snapshotted ids back to indices in the NOW-current doc and restore the
        // selection in this same transaction, so the caret survives the re-index intact.
        const anchorIndex = cursorToIndex(doc, { after: decodeId(cursor.anchorId) });
        const headIndex = cursorToIndex(doc, { after: decodeId(cursor.headId) });
        setSelectionFromIndices(tr, anchorIndex, headIndex);
        tr.setMeta("addToHistory", false);
        editor.view.dispatch(tr);
      });
      lastText = newText;
    } catch (err) {
      console.error("Failed to reconcile remote ops into the editor", err);
    }
  }

  return {
    syncEditorFromDoc,
    onLocalChange,
    onLocalSelectionChange,
    applyRemoteOps,
    destroy,
  };
}

/**
 * Build an {@link RGADocument} from a server snapshot, minting this tab's identity onto it.
 * The doc is the client-side source of CRDT truth; the bridge keeps the editor mirroring it.
 */
export function hydrateDocument(
  snapshot: DocumentSnapshot,
  identity: { replicaId: string; authorId: string },
): RGADocument {
  return RGADocument.fromSnapshot(snapshot, identity);
}

// `indexToPmPos` is re-exported so remote-cursor rendering can map a peer's anchor id → an
// editor coordinate without re-implementing the projection walk.
export { indexToPmPos };
