/**
 * The seam between TipTap's rich ProseMirror document and the CRDT's flat plaintext.
 *
 * CLAUDE.md pins v1 to a PLAINTEXT CRDT — "RGA orders plain chars only, no
 * CRDT-converging marks". So the CRDT sees the document as a single flat string: the
 * text of every block, joined by `"\n"` at block boundaries. This module is the
 * bidirectional projection between that string (indexed 0..N, the space the CRDT and
 * `@sync-flow/crdt`'s transform.ts speak) and ProseMirror positions (the space TipTap
 * transactions speak).
 *
 * UNIT CHOICE: everything here is measured in **UTF-16 code units**, exactly like
 * ProseMirror positions — NOT Unicode code points. That keeps the projection index and
 * the PM position in lockstep with no surrogate-pair bookkeeping. An astral character
 * (emoji) is therefore two adjacent CRDT chars (its two surrogate halves); they always
 * stay adjacent (each anchors after the previous), so `doc.text()` re-concatenates them
 * into the original character. `localInsert` accepts a lone surrogate — `[...c].length`
 * is 1 for a single code unit — so no op is ever rejected.
 *
 * KNOWN v1 LIMITATION: the projection is built from each textblock's `textContent`, so
 * inline leaf nodes with no text (a hard break from Shift+Enter) are not represented as
 * CRDT chars. Enter produces a paragraph split (a real `"\n"` in the projection) and IS
 * synced; hard breaks are treated like marks — local-only. Documented in PLAN.md.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

/** Block boundary in the flat projection — one code unit, mirrored by `doc.text()`'s `"\n"`. */
export const BLOCK_SEPARATOR = "\n";

interface Block {
  /** PM position of the first inline position inside the block (i.e. `nodePos + 1`). */
  readonly pmStart: number;
  /** Length of the block's text, in code units (== `pmEnd - pmStart` for a pure-text block). */
  readonly len: number;
  readonly text: string;
}

/** Enumerate the document's textblocks in document order. A textblock never nests, so we don't descend into one. */
function collectBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pmStart: pos + 1, len: node.content.size, text: node.textContent });
      return false;
    }
    return true;
  });
  return blocks;
}

/** The flat plaintext projection of a ProseMirror doc — the exact string the CRDT mirrors. */
export function docToText(doc: PMNode): string {
  return collectBlocks(doc)
    .map((b) => b.text)
    .join(BLOCK_SEPARATOR);
}

/**
 * Projection index (0..N) → ProseMirror position. An index that lands exactly on a block
 * boundary maps to the END of the preceding block's content, which is the correct target
 * both for appending to that block and for `tr.split()`.
 */
export function indexToPmPos(doc: PMNode, index: number): number {
  const blocks = collectBlocks(doc);
  if (blocks.length === 0) return 0;
  let rem = index <= 0 ? 0 : index;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (rem <= b.len) return b.pmStart + rem;
    rem -= b.len;
    if (i === blocks.length - 1) return b.pmStart + b.len; // clamp past the end
    rem -= 1; // consume the "\n" boundary between this block and the next
  }
  return doc.content.size;
}

/** ProseMirror position → projection index (0..N), the inverse of {@link indexToPmPos}. */
export function pmPosToIndex(doc: PMNode, pmPos: number): number {
  const blocks = collectBlocks(doc);
  let index = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const pmEnd = b.pmStart + b.len;
    if (pmPos <= pmEnd) {
      if (pmPos < b.pmStart) return index; // before the block's content → its start
      return index + (pmPos - b.pmStart);
    }
    index += b.len + 1; // block chars + the "\n" boundary
  }
  return index > 0 ? index - 1 : 0; // no trailing boundary after the last block
}

/**
 * A single contiguous edit expressed in projection-index space: delete `deleted` code
 * units at `from`, then insert `inserted`. Computed as the common-prefix/common-suffix
 * delta between two projections — the standard minimal single-range text diff, which
 * covers every ordinary edit (typing, deleting, selection-replace, paste).
 */
export interface TextDiff {
  readonly from: number;
  readonly deleted: number;
  readonly inserted: string;
}

/** Minimal single-range diff of two projection strings. Returns `null` when they are equal. */
export function diffText(oldText: string, newText: string): TextDiff | null {
  if (oldText === newText) return null;
  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    from: prefix,
    deleted: oldText.length - prefix - suffix,
    inserted: newText.slice(prefix, newText.length - suffix),
  };
}

/**
 * Build the minimal ProseMirror transaction that carries out `diff` on `state`. The
 * delete is one `tr.delete` (ProseMirror joins blocks across a boundary); the insert is
 * applied one code unit at a time so a `"\n"` becomes a real block split, re-resolving
 * the PM position from the evolving `tr.doc` at each step (correct without hand-tracking
 * token offsets). Callers mark the resulting transaction as remote-origin so the
 * editor's `onUpdate` doesn't re-emit it as a local op.
 */
export function buildRemoteTransaction(state: EditorState, diff: TextDiff): Transaction {
  const tr = state.tr;
  if (diff.deleted > 0) {
    const fromPM = indexToPmPos(tr.doc, diff.from);
    const toPM = indexToPmPos(tr.doc, diff.from + diff.deleted);
    tr.delete(fromPM, toPM);
  }
  for (let k = 0; k < diff.inserted.length; k++) {
    const ch = diff.inserted[k]!;
    const pos = indexToPmPos(tr.doc, diff.from + k);
    if (ch === BLOCK_SEPARATOR) {
      tr.split(pos);
    } else {
      tr.insertText(ch, pos);
    }
  }
  return tr;
}

/** The current selection endpoints as projection indices `{ anchor, head }`. */
export function selectionToIndices(state: EditorState): { anchor: number; head: number } {
  return {
    anchor: pmPosToIndex(state.doc, state.selection.anchor),
    head: pmPosToIndex(state.doc, state.selection.head),
  };
}

/**
 * Set `tr`'s selection from projection indices, clamped to the document. Used to restore
 * the caret after a remote edit re-indexed the doc, so it never jumps.
 */
export function setSelectionFromIndices(tr: Transaction, anchor: number, head: number): Transaction {
  const size = tr.doc.content.size;
  const anchorPos = Math.min(indexToPmPos(tr.doc, anchor), size);
  const headPos = Math.min(indexToPmPos(tr.doc, head), size);
  return tr.setSelection(TextSelection.create(tr.doc, anchorPos, headPos));
}
