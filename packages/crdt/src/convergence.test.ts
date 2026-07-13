import { describe, expect, it } from "vitest";
import { RGADocument } from "./document.js";
import { localInsert, localDelete, type Op } from "./operations.js";
import { makeDoc, applyAll, permutations } from "./harness.js";

/** Fork an independent replica that starts from `source`'s current state. */
function forkFrom(source: RGADocument, replicaId: string): RGADocument {
  return RGADocument.fromSnapshot(source.toSnapshot(), {
    replicaId,
    authorId: `user-${replicaId}`,
  });
}

/** Type a run of characters left-to-right starting at `startIndex`, collecting the ops. */
function typeRun(doc: RGADocument, startIndex: number, text: string): Op[] {
  const ops: Op[] = [];
  let i = startIndex;
  for (const ch of text) {
    ops.push(localInsert(doc, i, ch, { timestamp: 0 }));
    i += 1;
  }
  return ops;
}

/**
 * Apply `ops` in EVERY permutation to a fresh replica cloned from `base`, and
 * return the set of resulting texts. Convergence ⇒ that set has exactly one
 * element.
 */
function textsUnderEveryPermutation(base: RGADocument | null, ops: Op[]): Set<string> {
  const texts = new Set<string>();
  for (const perm of permutations(ops)) {
    const observer = base ? forkFrom(base, "observer") : makeDoc("observer");
    applyAll(observer, perm);
    texts.add(observer.text());
    // visibleCount must stay consistent with the materialized text.
    expect(observer.length).toBe([...observer.text()].length);
  }
  return texts;
}

describe("convergence under every permutation", () => {
  it("two runs inserted at the same position: contiguous, never interleaved, one result", () => {
    // Both replicas start empty and type a run at position 0 — the classic
    // concurrent-same-position case.
    const a = makeDoc("A");
    const b = makeDoc("B");
    const opsA = typeRun(a, 0, "abc");
    const opsB = typeRun(b, 0, "xyz");

    const texts = textsUnderEveryPermutation(null, [...opsA, ...opsB]);

    expect(texts.size).toBe(1); // all 720 orderings converge
    const [only] = [...texts];
    // Runs stay whole — one of the two contiguous orderings, NOT interleaved.
    expect(only).toMatch(/^(abcxyz|xyzabc)$/);
  });

  it("concurrent insert + delete + insert over a shared base converges", () => {
    const base = makeDoc("base");
    typeRun(base, 0, "cat");

    const a = forkFrom(base, "A");
    const b = forkFrom(base, "B");

    const aInsert = localInsert(a, 1, "X", { timestamp: 0 }); // "cXat"
    const aDelete = localDelete(a, 2); // delete 'a' -> "cXt"
    const bInsert = localInsert(b, 3, "Y", { timestamp: 0 }); // "catY"

    const texts = textsUnderEveryPermutation(base, [aInsert, aDelete, bInsert]);

    expect(texts.size).toBe(1);
    expect([...texts][0]).toBe("cXtY");
  });

  it("origin replicas themselves converge after exchanging ops", () => {
    const a = makeDoc("A");
    const b = makeDoc("B");
    const opsA = typeRun(a, 0, "Hello");
    const opsB = typeRun(b, 0, "World");

    applyAll(a, opsB); // A learns B's edits
    applyAll(b, opsA); // B learns A's edits

    expect(a.text()).toBe(b.text());
    expect(a.length).toBe(b.length);
  });

  it("re-delivering the same ops is a no-op (idempotency)", () => {
    const a = makeDoc("A");
    const b = makeDoc("B");
    const ops = [...typeRun(a, 0, "ab"), ...typeRun(b, 0, "cd")];

    const once = applyAll(makeDoc("obs1"), ops).text();
    const twice = applyAll(makeDoc("obs2"), [...ops, ...ops]).text();
    const observer = applyAll(makeDoc("obs3"), ops);
    applyAll(observer, ops); // deliver everything a second time

    expect(twice).toBe(once);
    expect(observer.text()).toBe(once);
    expect(observer.length).toBe([...once].length);
  });
});
