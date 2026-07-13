import { describe, expect, it } from "vitest";
import { RGADocument } from "./document.js";
import { localInsert, localDelete, type Op } from "./operations.js";
import { makeDoc, applyAll } from "./harness.js";

function forkFrom(source: RGADocument, replicaId: string): RGADocument {
  return RGADocument.fromSnapshot(source.toSnapshot(), {
    replicaId,
    authorId: `user-${replicaId}`,
  });
}

function typeRun(doc: RGADocument, startIndex: number, text: string): Op[] {
  const ops: Op[] = [];
  let i = startIndex;
  for (const ch of text) {
    ops.push(localInsert(doc, i, ch, { timestamp: 0 }));
    i += 1;
  }
  return ops;
}

/** Merge two concurrent op batches over a base, both delivery orders, assert equal + return text. */
function mergeBothOrders(base: RGADocument, first: Op[], second: Op[]): string {
  const ab = applyAll(forkFrom(base, "obs-ab"), [...first, ...second]);
  const ba = applyAll(forkFrom(base, "obs-ba"), [...second, ...first]);
  expect(ab.text()).toBe(ba.text());
  expect(ab.length).toBe(ba.length);
  expect(ab.length).toBe([...ab.text()].length);
  return ab.text();
}

describe("golden adversarial scenarios", () => {
  it("(a) A deletes 'world' while B inserts ' friends' after 'Hello'", () => {
    const base = makeDoc("base");
    typeRun(base, 0, "Hello world");

    const a = forkFrom(base, "A");
    const b = forkFrom(base, "B");

    // A deletes the 5 chars of "world" (indices 6..10); each delete shifts the
    // rest left, so repeatedly delete at index 6.
    const aOps: Op[] = [];
    for (let k = 0; k < 5; k++) aOps.push(localDelete(a, 6));
    expect(a.text()).toBe("Hello ");

    // B inserts " friends" after "Hello" (at index 5, before the space).
    const bOps = typeRun(b, 5, " friends");
    expect(b.text()).toBe("Hello friends world");

    const merged = mergeBothOrders(base, aOps, bOps);
    // "world" is gone; " friends" survived; both orders identical.
    expect(merged).toBe("Hello friends ");
    expect(merged).not.toContain("world");
    expect(merged).toContain("friends");
  });

  it("(b) concurrent delete of the same character is idempotent (no double effect)", () => {
    const base = makeDoc("base");
    typeRun(base, 0, "AB");

    const a = forkFrom(base, "A");
    const b = forkFrom(base, "B");

    const aDel = localDelete(a, 0); // both target the SAME char id 'A'
    const bDel = localDelete(b, 0);

    const merged = mergeBothOrders(base, [aDel], [bDel]);
    expect(merged).toBe("B");

    // Length decremented exactly once despite two deletes of the same char.
    const doc = applyAll(forkFrom(base, "obs"), [aDel, bDel]);
    expect(doc.length).toBe(1);
  });

  it("(c) inserting into a region another user just deleted keeps the insert, no resurrection", () => {
    const base = makeDoc("base");
    typeRun(base, 0, "abc");

    const a = forkFrom(base, "A");
    const b = forkFrom(base, "B");

    // A deletes the entire "abc".
    const aOps: Op[] = [];
    for (let k = 0; k < 3; k++) aOps.push(localDelete(a, 0));
    expect(a.text()).toBe("");

    // B inserts 'X' inside the region (after 'a'), anchored to a char A is deleting.
    const bOps = [localInsert(b, 1, "X", { timestamp: 0 })];

    const merged = mergeBothOrders(base, aOps, bOps);
    // The insert survives; a/b/c stay tombstoned (not resurrected).
    expect(merged).toBe("X");
  });

  it("(d) two users inserting runs at the exact same position do not interleave", () => {
    const a = makeDoc("A");
    const b = makeDoc("B");

    const opsA = typeRun(a, 0, "AAA");
    const opsB = typeRun(b, 0, "BBB");

    const observerAB = applyAll(makeDoc("obs-ab"), [...opsA, ...opsB]);
    const observerBA = applyAll(makeDoc("obs-ba"), [...opsB, ...opsA]);

    expect(observerAB.text()).toBe(observerBA.text());
    // Each run stays whole: "AAABBB" or "BBBAAA", never interleaved like "ABABAB".
    expect(observerAB.text()).toMatch(/^(AAABBB|BBBAAA)$/);
  });

  it("snapshot round-trips through JSON (JSONB-ready), preserving tombstones", () => {
    const doc = makeDoc("A");
    typeRun(doc, 0, "hello");
    localDelete(doc, 0); // tombstone 'h' -> visible "ello"

    const json = JSON.parse(JSON.stringify(doc.toSnapshot()));
    const restored = RGADocument.fromSnapshot(json, { replicaId: "B", authorId: "user-B" });

    expect(restored.text()).toBe("ello");
    expect(restored.length).toBe(4);
    // Tombstone preserved: the snapshot still carries the deleted 'h'.
    expect(json.chars.filter((c: { deleted: boolean }) => c.deleted)).toHaveLength(1);
    expect(json.chars).toHaveLength(5);

    // A restored replica keeps editing consistently with its Lamport position.
    const op = localInsert(restored, 4, "!", { timestamp: 0 });
    expect(op.charId.clock).toBeGreaterThan(json.clock);
    expect(restored.text()).toBe("ello!");
  });
});
