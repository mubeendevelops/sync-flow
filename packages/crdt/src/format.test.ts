import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RGADocument } from "./document.js";
import { localInsert, applyRemote, OP_VERSION, type FormatOp, type Op } from "./operations.js";
import { ROOT, type CharId } from "./id.js";

function fresh(replicaId: string): RGADocument {
  return new RGADocument({ replicaId, authorId: replicaId });
}

/** Mint a format op (by id, not localFormat's doc-clock-ticking convenience) on `doc` and apply it. */
function format(
  doc: RGADocument,
  charId: CharId,
  key: string,
  value: string | boolean | null,
  replicaId = doc.replicaId,
): FormatOp {
  const op: FormatOp = {
    type: "format",
    charId,
    key,
    value,
    clock: doc.clock.tick(),
    replicaId,
    opVersion: OP_VERSION,
  };
  doc.integrateFormat(op);
  return op;
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

describe("format ops", () => {
  it("sets and reads a boolean mark on a char", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    expect(doc.getFormat(ins.charId, "bold")).toBeNull();
    format(doc, ins.charId, "bold", true);
    expect(doc.getFormat(ins.charId, "bold")).toBe(true);
  });

  it("clearing a mark stores an explicit null, distinct from never-set", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    format(doc, ins.charId, "bold", true);
    format(doc, ins.charId, "bold", null);
    expect(doc.getFormat(ins.charId, "bold")).toBeNull();
  });

  it("supports a string-valued attribute (e.g. link href)", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    format(doc, ins.charId, "link", "https://example.com");
    expect(doc.getFormat(ins.charId, "link")).toBe("https://example.com");
  });

  it("ROOT is a valid format target (block-0 attributes anchor there)", () => {
    const doc = fresh("a");
    format(doc, ROOT, "blockType", "heading1");
    expect(doc.getFormat(ROOT, "blockType")).toBe("heading1");
  });

  it("is idempotent: re-applying the same format op changes nothing", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    const op = format(doc, ins.charId, "bold", true);
    expect(doc.integrateFormat(op)).toBe("duplicate");
    expect(doc.getFormat(ins.charId, "bold")).toBe(true);
  });

  it("different keys on the same char are independent registers", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    format(doc, ins.charId, "bold", true);
    format(doc, ins.charId, "italic", true);
    format(doc, ins.charId, "bold", null);
    expect(doc.getFormat(ins.charId, "bold")).toBeNull();
    expect(doc.getFormat(ins.charId, "italic")).toBe(true);
  });

  it("buffers a format op that outruns its target and flushes once the target lands", () => {
    const a = fresh("a");
    const ins = localInsert(a, 0, "X");
    const fmt = format(a, ins.charId, "bold", true);

    const b = fresh("b");
    expect(applyRemote(b, fmt)).toBe("buffered");
    expect(b.getFormat(ins.charId, "bold")).toBeNull();
    applyRemote(b, ins);
    expect(b.getFormat(ins.charId, "bold")).toBe(true);
  });

  it("LWW: the highest-stamp write wins regardless of delivery order", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    const first = format(doc, ins.charId, "blockType", "heading1", "r1");
    const second = format(doc, ins.charId, "blockType", "heading2", "r2");
    expect(doc.getFormat(ins.charId, "blockType")).toBe("heading2");

    for (let seed = 1; seed <= 20; seed += 1) {
      const r = fresh("r");
      for (const op of shuffle([ins, first, second], seed)) applyRemote(r, op);
      expect(r.getFormat(ins.charId, "blockType")).toBe("heading2");
    }
  });

  it("concurrent different-key marks on overlapping ranges converge under every delivery order", () => {
    // A bolds chars [0,1]; B italicizes chars [1,2] concurrently (char 1 overlaps). Every
    // replica must converge to the same {bold, italic} state per char regardless of order.
    const base = fresh("base");
    const chars = [localInsert(base, 0, "a"), localInsert(base, 1, "b"), localInsert(base, 2, "c")];

    const ops: Op[] = [...chars];
    const boldOps = [
      format(base, chars[0]!.charId, "bold", true, "A"),
      format(base, chars[1]!.charId, "bold", true, "A"),
    ];
    const italicOps = [
      format(base, chars[1]!.charId, "italic", true, "B"),
      format(base, chars[2]!.charId, "italic", true, "B"),
    ];
    ops.push(...boldOps, ...italicOps);

    const expected = chars.map((c) => ({
      bold: base.getFormat(c.charId, "bold"),
      italic: base.getFormat(c.charId, "italic"),
    }));
    expect(expected).toEqual([
      { bold: true, italic: null },
      { bold: true, italic: true },
      { bold: null, italic: true },
    ]);

    // Every permutation of delivery order converges to the same per-char state.
    for (let seed = 1; seed <= 50; seed += 1) {
      const r = fresh("r");
      for (const op of shuffle(ops, seed)) applyRemote(r, op);
      const actual = chars.map((c) => ({
        bold: r.getFormat(c.charId, "bold"),
        italic: r.getFormat(c.charId, "italic"),
      }));
      expect(actual).toEqual(expected);
    }
  });

  it("concurrent SAME-key writes to overlapping ranges resolve by LWW, converging under every order", () => {
    // A bolds [0,1]; B (concurrently, later clock) un-bolds [1,2]. Char 1 is contested.
    const base = fresh("base");
    const chars = [localInsert(base, 0, "a"), localInsert(base, 1, "b"), localInsert(base, 2, "c")];
    const ops: Op[] = [...chars];

    const aBold = [
      format(base, chars[0]!.charId, "bold", true, "A"),
      format(base, chars[1]!.charId, "bold", true, "A"),
    ];
    const bUnbold = [
      format(base, chars[1]!.charId, "bold", null, "B"),
      format(base, chars[2]!.charId, "bold", null, "B"),
    ];
    ops.push(...aBold, ...bUnbold);

    const expected = chars.map((c) => base.getFormat(c.charId, "bold"));
    // B's ops have strictly higher clocks (minted after A's on `base`), so B wins char 1.
    expect(expected).toEqual([true, null, null]);

    for (let seed = 1; seed <= 50; seed += 1) {
      const r = fresh("r");
      for (const op of shuffle(ops, seed)) applyRemote(r, op);
      expect(chars.map((c) => r.getFormat(c.charId, "bold"))).toEqual(expected);
    }
  });

  it("snapshot round-trips per-char formatting, including block-0 (ROOT) attributes", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "X");
    format(doc, ins.charId, "bold", true);
    format(doc, ins.charId, "link", "https://example.com");
    format(doc, ROOT, "blockType", "heading1");

    const restored = RGADocument.fromSnapshot(doc.toSnapshot(), { replicaId: "x", authorId: "x" });
    expect(restored.getFormat(ins.charId, "bold")).toBe(true);
    expect(restored.getFormat(ins.charId, "link")).toBe("https://example.com");
    expect(restored.getFormat(ROOT, "blockType")).toBe("heading1");

    // And LWW keeps working post-restore.
    format(restored, ins.charId, "bold", null);
    expect(restored.getFormat(ins.charId, "bold")).toBeNull();
  });

  it("a v2 snapshot (no `formats` field) loads with every char defaulting to no formatting", () => {
    const doc = fresh("a");
    localInsert(doc, 0, "X");
    const v2Snapshot = { ...doc.toSnapshot(), chars: doc.toSnapshot().chars.map((c) => ({ ...c, formats: undefined })) };
    const restored = RGADocument.fromSnapshot(v2Snapshot, { replicaId: "x", authorId: "x" });
    expect(restored.getFormat(restored.visibleChars()[0]!.id, "bold")).toBeNull();
  });

  it("property: format ops on N chars converge under every shuffled delivery order (10k cases)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            charIndex: fc.integer({ min: 0, max: 4 }),
            key: fc.constantFrom("bold", "italic"),
            value: fc.constantFrom<string | boolean | null>(true, null),
            replica: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 0, maxLength: 15 },
        ),
        fc.integer(),
        (actions, seed) => {
          const base = fresh("base");
          const chars = Array.from({ length: 5 }, (_, i) => localInsert(base, i, String(i)));
          const ops: Op[] = [...chars];

          for (const a of actions) {
            const charId = chars[a.charIndex]!.charId;
            const op: FormatOp = {
              type: "format",
              charId,
              key: a.key,
              value: a.value,
              clock: base.clock.tick(),
              replicaId: `r${a.replica}`,
              opVersion: OP_VERSION,
            };
            base.integrateFormat(op);
            ops.push(op);
          }

          const expected = chars.map((c) => ({
            bold: base.getFormat(c.charId, "bold"),
            italic: base.getFormat(c.charId, "italic"),
          }));

          const r = fresh("replica");
          for (const op of shuffle(ops, seed)) applyRemote(r, op);
          const actual = chars.map((c) => ({
            bold: r.getFormat(c.charId, "bold"),
            italic: r.getFormat(c.charId, "italic"),
          }));
          expect(actual).toEqual(expected);
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
