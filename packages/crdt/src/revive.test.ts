import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RGADocument } from "./document.js";
import {
  localInsert,
  localDelete,
  applyRemote,
  OP_VERSION,
  type DeleteOp,
  type ReviveOp,
  type Op,
} from "./operations.js";
import type { CharId } from "./id.js";

function fresh(replicaId: string): RGADocument {
  return new RGADocument({ replicaId, authorId: replicaId });
}

/** Mint a revive of `charId` on `doc` (advances its Lamport clock) and apply it. */
function revive(doc: RGADocument, charId: CharId, replicaId = doc.replicaId): ReviveOp {
  const op: ReviveOp = {
    type: "revive",
    charId,
    clock: doc.clock.tick(),
    replicaId,
    opVersion: OP_VERSION,
  };
  doc.integrateRevive(op);
  return op;
}

/** Mint a delete of `charId` (by id, not index) on `doc` and apply it. */
function deleteId(doc: RGADocument, charId: CharId, replicaId = doc.replicaId): DeleteOp {
  const op: DeleteOp = {
    type: "delete",
    charId,
    clock: doc.clock.tick(),
    replicaId,
    opVersion: OP_VERSION,
  };
  doc.integrateDelete(op);
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

describe("revive (undo of delete)", () => {
  it("brings a deleted char back at its original position", () => {
    const doc = fresh("a");
    localInsert(doc, 0, "H");
    localInsert(doc, 1, "i");
    const del = localDelete(doc, 0); // delete "H"
    expect(doc.text()).toBe("i");

    revive(doc, del.charId);
    expect(doc.text()).toBe("Hi"); // reappears at index 0, not appended
  });

  it("revives at the original RGA position even after others edit around the gap", () => {
    // "abc"; delete "b"; another replica inserts "X" where b was; revive b.
    const a = fresh("a");
    const ops: Op[] = [];
    ops.push(localInsert(a, 0, "a"));
    ops.push(localInsert(a, 1, "b"));
    ops.push(localInsert(a, 2, "c"));
    const delB = localDelete(a, 1); // "ac"
    ops.push(delB);
    expect(a.text()).toBe("ac");

    // Peer edits around the gap: insert "X" between a and c.
    const b = fresh("b");
    for (const op of ops) applyRemote(b, op);
    const insX = localInsert(b, 1, "X"); // "aXc" on b
    applyRemote(a, insX);
    expect(a.text()).toBe("aXc");

    // Revive "b": it returns to its original slot (between a and X, per RGA order).
    const rev = revive(a, delB.charId);
    applyRemote(b, rev);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toContain("b");
    expect(a.text()).toContain("X");
  });

  it("undo of an insert that another user already deleted is a visible no-op (idempotency)", () => {
    // A inserts X; B deletes X; A 'undoes' its insert by deleting X too.
    const a = fresh("a");
    const insX = localInsert(a, 0, "X");
    const b = fresh("b");
    applyRemote(b, insX);
    const delByB = deleteId(b, insX.charId); // B deletes X
    applyRemote(a, delByB);
    expect(a.text()).toBe("");

    // A's undo-of-insert = delete X. Already hidden → stays hidden, converges.
    const undo = deleteId(a, insX.charId);
    applyRemote(b, undo);
    expect(a.text()).toBe("");
    expect(b.text()).toBe("");
  });

  it("LWW: the highest-stamp visibility op wins regardless of delivery order", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "Z");
    const del = deleteId(doc, ins.charId); // hidden
    const rev = revive(doc, ins.charId); // visible (higher clock than del)
    expect(doc.text()).toBe("Z");

    // Deliver {ins, del, rev} to a fresh replica in every order → same result.
    for (let seed = 1; seed <= 20; seed += 1) {
      const r = fresh("r");
      for (const op of shuffle([ins, del, rev], seed)) applyRemote(r, op);
      expect(r.text()).toBe("Z"); // rev has the highest stamp
    }
  });

  it("a later delete outranks an earlier revive", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "Z");
    const del1 = deleteId(doc, ins.charId);
    const rev = revive(doc, ins.charId); // visible
    const del2 = deleteId(doc, ins.charId); // hidden again (highest clock)
    expect(doc.text()).toBe("");

    for (let seed = 1; seed <= 20; seed += 1) {
      const r = fresh("r");
      for (const op of shuffle([ins, del1, rev, del2], seed)) applyRemote(r, op);
      expect(r.text()).toBe(""); // del2 wins
    }
  });

  it("revive is idempotent and buffers if it outruns its target", () => {
    const a = fresh("a");
    const ins = localInsert(a, 0, "Q");
    const del = localDelete(a, 0);
    const rev = revive(a, del.charId);

    // A replica that receives revive BEFORE insert/delete buffers then resolves it.
    const b = fresh("b");
    applyRemote(b, rev); // buffered (target unknown)
    expect(b.text()).toBe("");
    applyRemote(b, ins);
    applyRemote(b, del);
    // revive was buffered on the target key and flushed when the char landed.
    expect(b.text()).toBe("Q");
    // Re-applying every op changes nothing.
    for (const op of [ins, del, rev]) applyRemote(b, op);
    expect(b.text()).toBe("Q");
  });

  it("snapshot round-trips visibility (a revived char survives serialize/deserialize)", () => {
    const doc = fresh("a");
    const ins = localInsert(doc, 0, "R");
    deleteId(doc, ins.charId);
    revive(doc, ins.charId);
    expect(doc.text()).toBe("R");

    const restored = RGADocument.fromSnapshot(doc.toSnapshot(), { replicaId: "x", authorId: "x" });
    expect(restored.text()).toBe("R");

    // And a subsequent delete still resolves correctly against the restored stamp.
    deleteId(restored, ins.charId);
    expect(restored.text()).toBe("");
  });

  it("property: N delete/revive ops on one char converge to the highest-stamp op's effect", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ kind: fc.constantFrom("del", "rev"), r: fc.integer({ min: 0, max: 3 }) }), {
          minLength: 0,
          maxLength: 12,
        }),
        fc.integer(),
        (actions, seed) => {
          const base = fresh("base");
          const ins = localInsert(base, 0, "C");
          const ops: Op[] = [ins];
          // Each action mints a delete or revive with a strictly increasing clock.
          for (const a of actions) {
            const charId = ins.charId;
            const clock = base.clock.tick();
            const replicaId = `r${a.r}`;
            if (a.kind === "del") {
              const op: DeleteOp = { type: "delete", charId, clock, replicaId, opVersion: OP_VERSION };
              base.integrateDelete(op);
              ops.push(op);
            } else {
              const op: ReviveOp = { type: "revive", charId, clock, replicaId, opVersion: OP_VERSION };
              base.integrateRevive(op);
              ops.push(op);
            }
          }
          const expected = base.text();
          // The last action determines visibility (strictly increasing clocks).
          const lastVisible = actions.length === 0 || actions[actions.length - 1]!.kind === "rev";
          expect(expected).toBe(lastVisible ? "C" : "");

          // Any replica applying the same ops in any order converges to `expected`.
          const r = fresh("replica");
          for (const op of shuffle(ops, seed)) applyRemote(r, op);
          expect(r.text()).toBe(expected);
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
