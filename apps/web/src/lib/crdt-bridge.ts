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
import type { Node as PMNode, NodeType, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  type Op,
  type FormatOp,
  type DocumentSnapshot,
  type CharId,
  RGADocument,
  ROOT,
  encodeId,
  decodeId,
  idsEqual,
  localInsert,
  localDelete,
  localFormat,
  applyRemote,
  cursorFromIndex,
  cursorToIndex,
  idToIndex,
} from "@sync-flow/crdt";
import {
  docToText,
  diffText,
  buildRemoteTransaction,
  selectionToIndices,
  setSelectionFromIndices,
  indexToPmPos,
  collectBlockInfos,
  collectProjectedChars,
  MARK_KEYS,
  BLOCK_SEPARATOR,
  type BlockTypeName,
} from "@/lib/text-projection";

/**
 * The block/anchor char for block index `bi`: `ROOT` for the first block, or the CharId of
 * the `"\n"` separator that precedes block `bi` otherwise. Block-level attributes (heading
 * level, list type) are format ops targeting this anchor rather than a real text char — see
 * `FormatOp`'s doc comment in `packages/crdt/src/operations.ts`. Anchors are stable across
 * edits because "\n" chars are tombstoned, never structurally removed.
 */
function computeBlockAnchors(doc: RGADocument): CharId[] {
  const anchors: CharId[] = [ROOT];
  for (const vc of doc.visibleChars()) {
    if (vc.char === BLOCK_SEPARATOR) anchors.push(vc.id);
  }
  return anchors;
}

/** Resolve a stored `blockType` value to the PM node type + attrs `setBlockType` needs. */
function blockNodeTypeFor(
  schema: Schema,
  blockType: string | null,
): { type: NodeType; attrs?: Record<string, unknown> } | null {
  const heading = schema.nodes.heading;
  switch (blockType as BlockTypeName | null) {
    case "heading1":
      return heading ? { type: heading, attrs: { level: 1 } } : null;
    case "heading2":
      return heading ? { type: heading, attrs: { level: 2 } } : null;
    case "heading3":
      return heading ? { type: heading, attrs: { level: 3 } } : null;
    case "codeBlock":
      return schema.nodes.codeBlock ? { type: schema.nodes.codeBlock } : null;
    default:
      return schema.nodes.paragraph ? { type: schema.nodes.paragraph } : null;
  }
}

/**
 * Diff the editor's current formatting (marks + block types/lists) against the CRDT's stored
 * truth, minting one `FormatOp` per delta (editor wins — this runs right after the user's own
 * edit). Runs unconditionally on every local change, not just mark-toggle commands, so text
 * typed while a mark is active (TipTap applies "stored marks" to newly inserted text without a
 * separate AddMark step) still gets captured.
 */
function mintFormatOps(doc: RGADocument, pmDoc: PMNode): Op[] {
  const ops: Op[] = [];
  const chars = collectProjectedChars(pmDoc);
  const visible = doc.visibleChars();
  const n = Math.min(chars.length, visible.length);
  for (let i = 0; i < n; i++) {
    const pc = chars[i]!;
    const vc = visible[i]!;
    if (pc.char === BLOCK_SEPARATOR) continue;
    for (const key of MARK_KEYS) {
      const editorValue: string | boolean = pc.marks[key] ?? false;
      const crdtValue = doc.getFormat(vc.id, key) ?? false;
      if (editorValue !== crdtValue) {
        ops.push(localFormat(doc, vc.id, key, editorValue === false ? null : editorValue));
      }
    }
  }

  const blocks = collectBlockInfos(pmDoc);
  const anchors = computeBlockAnchors(doc);
  const bn = Math.min(blocks.length, anchors.length);
  for (let bi = 0; bi < bn; bi++) {
    const block = blocks[bi]!;
    const anchorId = anchors[bi]!;
    const crdtBlockType = doc.getFormat(anchorId, "blockType") ?? "paragraph";
    if (block.blockType !== crdtBlockType) {
      ops.push(localFormat(doc, anchorId, "blockType", block.blockType));
    }
    const crdtListType = doc.getFormat(anchorId, "listType") ?? null;
    if (block.listType !== crdtListType) {
      ops.push(localFormat(doc, anchorId, "listType", block.listType));
    }
  }
  return ops;
}

/** A (charId, key) pair whose format state needs reconciling into the editor. */
interface FormatTarget {
  readonly charId: CharId;
  readonly key: string;
}

/**
 * A remote batch can integrate out of order: a format op whose target char hasn't arrived
 * yet is buffered inside `document.ts` and cascade-flushed there once the char lands LATER
 * in the same batch — that flush's result never surfaces back to this loop's `applyRemote`
 * return value. So targets are deduped by `(charId, key)` and every target's value is read
 * FRESH from `doc.getFormat` (the CRDT's current, already-resolved truth) rather than trusted
 * from the specific op instance that happened to name it — otherwise a batch delivered in an
 * unlucky order silently drops the reconciliation, even though `doc` itself is correct.
 */
function dedupeFormatTargets(ops: readonly FormatOp[]): FormatTarget[] {
  const seen = new Map<string, FormatTarget>();
  for (const op of ops) {
    seen.set(`${encodeId(op.charId)}:${op.key}`, { charId: op.charId, key: op.key });
  }
  return [...seen.values()];
}

/**
 * Apply the current CRDT-truth formatting for `targets` onto `tr`. Inline marks are applied
 * directly via `addMark`/`removeMark` at the char's current position. `blockType` re-types the
 * containing block. `listType` is a known v1 limitation — captured and stored (converges,
 * round-trips through snapshots) but not yet live-reconciled into a remote peer's editor.
 */
function applyFormatOpsToTransaction(
  tr: Transaction,
  doc: RGADocument,
  ops: readonly FormatOp[],
  schema: Schema,
): void {
  const targets = dedupeFormatTargets(ops);
  if (targets.length === 0) return;
  const blockAnchors = computeBlockAnchors(doc);

  for (const target of targets) {
    if (target.key === "listType") continue; // see doc comment above
    const value = doc.getFormat(target.charId, target.key);

    if (target.key === "blockType") {
      const bi = blockAnchors.findIndex((a) => idsEqual(a, target.charId));
      if (bi === -1) continue;
      const info = collectBlockInfos(tr.doc)[bi];
      if (!info) continue;
      const type = blockNodeTypeFor(schema, typeof value === "string" ? value : null);
      if (type) tr.setBlockType(info.pmStart, info.pmStart + info.len, type.type, type.attrs);
      continue;
    }

    // Inline mark.
    const index = idToIndex(doc, target.charId);
    if (index === -1) continue; // tombstoned — no visible position to mark
    const from = indexToPmPos(tr.doc, index);
    const to = from + 1;
    const markType = schema.marks[target.key];
    if (!markType) continue;
    if (value === null || value === false) {
      tr.removeMark(from, to, markType);
    } else if (target.key === "link" && typeof value === "string") {
      tr.addMark(from, to, markType.create({ href: value }));
    } else {
      tr.addMark(from, to, markType.create());
    }
  }
}

/** Build PM text nodes for one block's chars, grouping consecutive chars with identical marks into runs. */
function buildInlineContent(
  schema: Schema,
  chars: readonly { readonly id: CharId; readonly char: string }[],
  doc: RGADocument,
  allowMarks: boolean,
): PMNode[] {
  const nodes: PMNode[] = [];
  let runText = "";
  let runKey = "";
  let runMarks: { key: string; value: string | boolean }[] = [];

  const flush = () => {
    if (runText.length === 0) return;
    const marks = allowMarks
      ? runMarks.flatMap(({ key, value }) => {
          const markType = schema.marks[key];
          if (!markType) return [];
          return [key === "link" && typeof value === "string" ? markType.create({ href: value }) : markType.create()];
        })
      : [];
    nodes.push(schema.text(runText, marks));
    runText = "";
  };

  for (const vc of chars) {
    const marks: { key: string; value: string | boolean }[] = [];
    for (const key of MARK_KEYS) {
      const value = doc.getFormat(vc.id, key);
      if (value !== null && value !== false) marks.push({ key, value });
    }
    const key = marks.map((m) => `${m.key}=${String(m.value)}`).join("|");
    if (runText.length > 0 && key !== runKey) flush();
    runKey = key;
    runMarks = marks;
    runText += vc.char;
  }
  flush();
  return nodes;
}

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

  /** Rebuild the editor doc from scratch, one PM block node per CRDT block, carrying each
   * block's stored `blockType` and each char's stored inline marks. Used on hydrate/reload —
   * without this, formatting would render correctly live but vanish on every page reload. */
  function syncEditorFromDoc(): void {
    const schema = editor.schema;
    const anchors = computeBlockAnchors(doc);
    const visible = doc.visibleChars();

    const blocksChars: (typeof visible)[] = [[]];
    for (const vc of visible) {
      if (vc.char === BLOCK_SEPARATOR) blocksChars.push([]);
      else blocksChars[blocksChars.length - 1]!.push(vc);
    }

    const pmNodes = blocksChars.map((chars, bi) => {
      const anchorId = anchors[bi] ?? ROOT;
      const blockType = doc.getFormat(anchorId, "blockType");
      const target = blockNodeTypeFor(schema, typeof blockType === "string" ? blockType : null);
      const nodeType = target?.type ?? schema.nodes.paragraph;
      if (!nodeType) throw new Error("editor schema has no paragraph node type");
      const allowMarks = nodeType.name !== "codeBlock";
      const content = chars.length > 0 ? buildInlineContent(schema, chars, doc, allowMarks) : undefined;
      return nodeType.create(target?.attrs, content);
    });
    const newDoc = schema.node("doc", null, pmNodes);
    dispatchProgrammatic(() => {
      const tr = editor.state.tr;
      tr.replaceWith(0, editor.state.doc.content.size, newDoc.content);
      tr.setMeta("addToHistory", false);
      editor.view.dispatch(tr);
    });
    lastText = doc.text();
  }

  function onLocalChange(): void {
    if (applying) return;
    const newText = docToText(editor.state.doc);
    const diff = diffText(lastText, newText);

    const ops: Op[] = [];
    if (diff) {
      // Delete right-to-left so each removal leaves the lower indices untouched.
      for (let i = diff.from + diff.deleted - 1; i >= diff.from; i--) {
        ops.push(localDelete(doc, i));
      }
      // Insert left-to-right, one code unit per CRDT char.
      for (let k = 0; k < diff.inserted.length; k++) {
        ops.push(localInsert(doc, diff.from + k, diff.inserted[k]!));
      }
      lastText = newText;
    }

    // Runs on every local change, not just when text changed — a transaction that only
    // toggles a mark or a block type produces no text diff at all, and was previously
    // invisible to the bridge entirely (the bug this fixes).
    ops.push(...mintFormatOps(doc, editor.state.doc));

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

      // Every format op in the batch is handed to reconciliation regardless of its own
      // apply result — a batch can integrate out of order, cascade-flushing a buffered
      // format op from inside `document.ts` where this loop never sees it "applied" (see
      // `dedupeFormatTargets`'s doc comment). Reconciliation reads current CRDT truth, so
      // this is correct even for ops that were themselves a no-op/duplicate/buffered here.
      const formatOps: FormatOp[] = [];
      for (const op of foreign) {
        try {
          applyRemote(doc, op);
          if (op.type === "format") formatOps.push(op);
        } catch (err) {
          console.error("Failed to apply remote CRDT op — skipping it", op, err);
        }
      }

      const newText = doc.text();
      const diff = diffText(docToText(editor.state.doc), newText);
      // A pure formatting change (no text diff) still needs reconciling — this used to bail
      // out here unconditionally, silently dropping every formatting-only remote op.
      if (!diff && formatOps.length === 0) return;

      dispatchProgrammatic(() => {
        const tr = diff ? buildRemoteTransaction(editor.state, diff) : editor.state.tr;
        applyFormatOpsToTransaction(tr, doc, formatOps, editor.schema);
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
