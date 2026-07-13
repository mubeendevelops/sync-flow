/**
 * Translation between the user-visible linear index (what a text editor speaks)
 * and CRDT char ids (what the document speaks), in both directions — plus cursor
 * handling across remote edits.
 *
 * Cursors are the interesting part. A cursor stored as a raw integer is fragile:
 * every remote insert/delete to its left silently shifts it, and you must
 * transform it against each incoming op or it desyncs. Instead we store a cursor
 * as an ANCHOR — the id of the visible char immediately to its left (or ROOT at
 * the start) — and recompute its integer index on demand from current document
 * state (`cursorToIndex`). Remote ops then need no cursor bookkeeping at all, and
 * if the char under the anchor is deleted we fall back to the nearest surviving
 * char to its left. `rebaseIndexThrough*` implement the classic integer-shift
 * transform too, for callers that insist on it, but the anchor approach is what
 * the editor should use.
 *
 * All functions here are O(n) (they scan the visible sequence) — the same class
 * as `localInsert`/`localDelete`, and the same thing an order-statistics index
 * would drop to O(log n). See the perf note in the package README/benchmark.
 */

import { type CharId, ROOT, idsEqual } from "./id.js";
import type { RGADocument } from "./document.js";

/** A cursor/selection endpoint, anchored to the visible char on its left. */
export interface Cursor {
  readonly after: CharId;
}

/** Id of the visible character at position `index`. Throws if out of range. */
export function visibleIdAt(doc: RGADocument, index: number): CharId {
  const chars = doc.visibleChars();
  const entry = chars[index];
  if (!entry) {
    throw new RangeError(`visibleIdAt: index ${index} out of range (length ${chars.length})`);
  }
  return entry.id;
}

/**
 * The anchor to insert after so a new char lands at visible position `index`:
 * the char just left of `index`, or ROOT when inserting at the very start.
 */
export function insertAnchorAt(doc: RGADocument, index: number): CharId {
  if (index <= 0) return ROOT;
  return visibleIdAt(doc, index - 1);
}

/** Visible position of `id`, or -1 if `id` is not a visible character. */
export function idToIndex(doc: RGADocument, id: CharId): number {
  const chars = doc.visibleChars();
  for (let i = 0; i < chars.length; i++) {
    const entry = chars[i];
    if (entry && idsEqual(entry.id, id)) return i;
  }
  return -1;
}

/** Build a stable cursor for visible position `index`. */
export function cursorFromIndex(doc: RGADocument, index: number): Cursor {
  return { after: insertAnchorAt(doc, index) };
}

/**
 * Resolve a stored cursor to a current visible index. If the anchor char was
 * deleted, snaps to just after the nearest surviving char to its left (or to 0
 * at the document start).
 */
export function cursorToIndex(doc: RGADocument, cursor: Cursor): number {
  const left = doc.nearestVisibleLeft(cursor.after);
  if (left === null) return 0;
  return idToIndex(doc, left) + 1;
}

/**
 * Classic integer-shift transform for a remote INSERT that landed at visible
 * position `insertIndex`. Prefer the anchor-based cursor above; this exists for
 * callers that keep integer cursors. An insert at or left of the cursor pushes
 * it right by one.
 */
export function rebaseIndexThroughInsert(cursorIndex: number, insertIndex: number): number {
  return insertIndex <= cursorIndex ? cursorIndex + 1 : cursorIndex;
}

/**
 * Classic integer-shift transform for a remote DELETE of the char that was at
 * visible position `deleteIndex`. A deletion strictly left of the cursor pulls
 * it left by one.
 */
export function rebaseIndexThroughDelete(cursorIndex: number, deleteIndex: number): number {
  return deleteIndex < cursorIndex ? cursorIndex - 1 : cursorIndex;
}
