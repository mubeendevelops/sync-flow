import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RGADocument, type DocumentIdentity } from "./document.js";
import { localInsert, applyRemote, type Op } from "./operations.js";
import { reconcileToText } from "./reconcile.js";

const RESTORE: DocumentIdentity = { replicaId: "restore-replica", authorId: "restore-user" };

/** A fresh replica with `text` typed into it left-to-right, plus the ops that built it. */
function docWith(text: string, replicaId: string): { doc: RGADocument; ops: Op[] } {
  const doc = new RGADocument({ replicaId, authorId: replicaId });
  const chars = [...text];
  const ops: Op[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    ops.push(localInsert(doc, i, chars[i]!, { timestamp: 1 }));
  }
  return { doc, ops };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("reconcileToText", () => {
  it("transforms the local doc to exactly the target text", () => {
    const { doc } = docWith("Hello World", "a");
    reconcileToText(doc, "Hello, brave World", RESTORE, { timestamp: 2 });
    expect(doc.text()).toBe("Hello, brave World");
  });

  it("is a no-op when the doc already reads the target", () => {
    const { doc } = docWith("unchanged", "a");
    const ops = reconcileToText(doc, "unchanged", RESTORE);
    expect(ops).toEqual([]);
    expect(doc.text()).toBe("unchanged");
  });

  it("reconciling to empty tombstones everything (deletes, never structural removal)", () => {
    const { doc } = docWith("gone", "a");
    const ops = reconcileToText(doc, "", RESTORE);
    expect(doc.text()).toBe("");
    expect(ops.every((op) => op.type === "delete")).toBe(true);
    expect(ops).toHaveLength(4);
  });

  it("only touches the changed region (LCS keeps the common prefix/suffix)", () => {
    const { doc } = docWith("the quick brown fox", "a");
    // Change only "quick" -> "slow"; prefix "the " and suffix " brown fox" are kept.
    const ops = reconcileToText(doc, "the slow brown fox", RESTORE);
    expect(doc.text()).toBe("the slow brown fox");
    // "quick"(5) -> "slow"(4): at most a handful of ops, never a full re-type of 18 chars.
    expect(ops.length).toBeLessThan(12);
  });

  it("a peer that had the same base state converges by applying the restore ops", () => {
    const { doc: a, ops: base } = docWith("Hello World", "a");
    const b = new RGADocument({ replicaId: "b", authorId: "b" });
    for (const op of base) applyRemote(b, op);

    const restore = reconcileToText(a, "Goodbye World", RESTORE, { timestamp: 2 });
    for (const op of restore) applyRemote(b, op);

    expect(a.text()).toBe("Goodbye World");
    expect(b.text()).toBe("Goodbye World");
  });

  it("is undoable: reconcile forward then back restores the original text byte-for-byte", () => {
    const { doc } = docWith("version one", "a");
    const original = doc.text();
    reconcileToText(doc, "version two, longer", RESTORE, { timestamp: 2 });
    expect(doc.text()).toBe("version two, longer");
    reconcileToText(doc, original, RESTORE, { timestamp: 3 });
    expect(doc.text()).toBe(original);
  });

  it("preserves an edit made concurrently with the restore (both survive, converge)", () => {
    // Server-side doc the restore runs against.
    const { doc: server, ops: base } = docWith("Hello World", "a");

    // A client mirrors the base, then types "!" at the end concurrently — the server
    // has NOT seen this op when it computes the restore diff.
    const client = new RGADocument({ replicaId: "client", authorId: "client" });
    for (const op of base) applyRemote(client, op);
    const concurrent = localInsert(client, client.length, "!", { timestamp: 5 });

    // Restore the server doc to a different version (client's "!" not included).
    const restore = reconcileToText(server, "Hello There", RESTORE, { timestamp: 2 });

    // Both sides exchange what the other missed, in arbitrary order.
    for (const op of shuffle([...restore, concurrent], 7)) applyRemote(client, op);
    applyRemote(server, concurrent);

    expect(server.text()).toBe(client.text());
    // The restored text is present, and the concurrent "!" was not lost.
    expect(server.text()).toContain("Hello There");
    expect(server.text()).toContain("!");
  });

  const smallText = fc.string({ minLength: 0, maxLength: 24 });

  it("property: doc reads target after reconcile, and a mirror converges under shuffled delivery", () => {
    fc.assert(
      fc.property(smallText, smallText, fc.integer(), (start, target, seed) => {
        const { doc, ops: base } = docWith(start, "a");
        const mirror = new RGADocument({ replicaId: "m", authorId: "m" });
        for (const op of base) applyRemote(mirror, op);

        const restore = reconcileToText(doc, target, RESTORE, { timestamp: 2 });

        // Local doc is exactly the target.
        expect(doc.text()).toBe([...target].join(""));

        // A peer applying the same ops in a shuffled order converges (commutativity +
        // buffering of ops that outrun their anchor/target).
        for (const op of shuffle(restore, seed)) applyRemote(mirror, op);
        expect(mirror.text()).toBe(doc.text());

        // Re-applying every op is a no-op (idempotency).
        for (const op of restore) applyRemote(mirror, op);
        expect(mirror.text()).toBe(doc.text());
      }),
      { numRuns: 10_000 },
    );
  });
});
