import { describe, it } from "vitest";
import fc from "fast-check";
import { localInsert, localDelete, type Op } from "./operations.js";
import { makeDoc, applyAll, seededShuffle } from "./harness.js";

/**
 * Property-based convergence: generate random concurrent edits across 3+ replicas
 * (each editing its own partitioned replica, seeing none of the others), then
 * heal by delivering the union of all ops to fresh observers in several delivery
 * orders. Every observer must converge to the same text, and re-delivering every
 * op must change nothing (idempotency).
 *
 * Runs at 10_000 cases to satisfy the CRDT Definition of Done (≥10k), which is
 * the binding requirement above the spec's looser "a few thousand".
 */

type Edit =
  | { readonly kind: "insert"; readonly char: string; readonly frac: number }
  | { readonly kind: "delete"; readonly frac: number };

const letterArb = fc.integer({ min: 97, max: 122 }).map((c) => String.fromCharCode(c));

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    char: letterArb,
    frac: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    frac: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
);

const scenarioArb = fc.record({
  // 3+ replicas per the spec.
  replicas: fc.array(fc.array(editArb, { maxLength: 8 }), { minLength: 3, maxLength: 5 }),
  seeds: fc.array(fc.integer(), { minLength: 3, maxLength: 3 }),
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Replay one replica's edits on its own empty doc, collecting the ops it emits. */
function opsForReplica(replicaId: string, edits: readonly Edit[]): Op[] {
  const doc = makeDoc(replicaId);
  const ops: Op[] = [];
  for (const edit of edits) {
    if (edit.kind === "insert") {
      const index = clamp(Math.floor(edit.frac * (doc.length + 1)), 0, doc.length);
      ops.push(localInsert(doc, index, edit.char, { timestamp: 0 }));
    } else {
      if (doc.length === 0) continue;
      const index = clamp(Math.floor(edit.frac * doc.length), 0, doc.length - 1);
      ops.push(localDelete(doc, index));
    }
  }
  return ops;
}

describe("property: convergence under random concurrent edits + shuffled delivery", () => {
  it("all replicas converge and delivery is idempotent (10k cases)", () => {
    fc.assert(
      fc.property(scenarioArb, ({ replicas, seeds }) => {
        const allOps = replicas.flatMap((edits, r) => opsForReplica(`R${r}`, edits));

        // Deliver the union in several orders (natural + seeded shuffles).
        const orders = [allOps, ...seeds.map((s) => seededShuffle(allOps, s))];
        const texts = orders.map((order) => applyAll(makeDoc("obs"), order).text());

        const ref = texts[0]!;
        const converged = texts.every((t) => t === ref);

        // Idempotency: deliver every op twice.
        const doubled = applyAll(makeDoc("obs-dup"), [...allOps, ...allOps]);

        // Visible count stays consistent with the materialized text.
        const lengthConsistent = doubled.length === [...doubled.text()].length;

        return converged && doubled.text() === ref && lengthConsistent;
      }),
      { numRuns: 10_000 },
    );
  }, 120_000);
});
