import { describe, it, expect } from "vitest";
import { makeDoc } from "./harness.js";
import { localInsert, localDelete } from "./operations.js";
import { ROOT } from "./id.js";
import {
  visibleIdAt,
  insertAnchorAt,
  idToIndex,
  cursorFromIndex,
  cursorToIndex,
  rebaseIndexThroughInsert,
  rebaseIndexThroughDelete,
} from "./transform.js";

describe("transform", () => {
  it("visibleIdAt returns the id at a valid index and throws out of range", () => {
    const doc = makeDoc("r1");
    localInsert(doc, 0, "a");
    localInsert(doc, 1, "b");
    expect(visibleIdAt(doc, 0).clock).toBeGreaterThan(0);
    expect(() => visibleIdAt(doc, 5)).toThrow(RangeError);
    expect(() => visibleIdAt(doc, -1)).toThrow(RangeError);
  });

  it("insertAnchorAt returns ROOT at index 0 and the left char id otherwise", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    expect(insertAnchorAt(doc, 0)).toEqual(ROOT);
    expect(insertAnchorAt(doc, -1)).toEqual(ROOT);
    expect(insertAnchorAt(doc, 1)).toEqual(a.charId);
  });

  it("idToIndex finds a visible id's position, or -1 if absent/tombstoned", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    const b = localInsert(doc, 1, "b");
    expect(idToIndex(doc, b.charId)).toBe(1);
    localDelete(doc, 1);
    expect(idToIndex(doc, b.charId)).toBe(-1);
    expect(idToIndex(doc, a.charId)).toBe(0);
  });

  it("cursorFromIndex delegates to insertAnchorAt", () => {
    const doc = makeDoc("r1");
    localInsert(doc, 0, "a");
    expect(cursorFromIndex(doc, 0)).toEqual({ after: ROOT });
  });

  it("cursorToIndex resolves a live anchor, snaps left past a deleted anchor, and handles the doc start", () => {
    const doc = makeDoc("r1");
    localInsert(doc, 0, "a");
    localInsert(doc, 1, "b");
    const cursorAtA = cursorFromIndex(doc, 1); // after "a"
    expect(cursorToIndex(doc, cursorAtA)).toBe(1);

    // Anchor to "b", then delete "a" out from under a cursor anchored at the very start.
    const startCursor = cursorFromIndex(doc, 0); // after: ROOT
    expect(cursorToIndex(doc, startCursor)).toBe(0);

    // Anchor a cursor to "a" itself, then delete "a" — should snap to the nearest
    // surviving char to its left, which is ROOT (start of doc) here.
    localDelete(doc, 0);
    expect(cursorToIndex(doc, cursorAtA)).toBe(0);
  });

  it("rebaseIndexThroughInsert shifts right at/left of the cursor, not right of it", () => {
    expect(rebaseIndexThroughInsert(5, 5)).toBe(6);
    expect(rebaseIndexThroughInsert(5, 0)).toBe(6);
    expect(rebaseIndexThroughInsert(5, 6)).toBe(5);
  });

  it("rebaseIndexThroughDelete shifts left strictly left of the cursor, not at/right of it", () => {
    expect(rebaseIndexThroughDelete(5, 4)).toBe(4);
    expect(rebaseIndexThroughDelete(5, 5)).toBe(5);
    expect(rebaseIndexThroughDelete(5, 6)).toBe(5);
  });
});
