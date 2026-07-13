import { describe, expect, it } from "vitest";
import { makeDoc, applyAll } from "./harness.js";
import { localInsert, localDelete } from "./operations.js";

/**
 * 100k-character benchmark. Reports real numbers and guards against catastrophic
 * regressions with deliberately loose bounds (≫ observed, so machine jitter never
 * flakes it).
 *
 * PERFORMANCE CLIFF (documented honestly): positional ops are O(n) in this naive
 * RGA because turning a linear index into an anchor id scans the visible
 * sequence. So:
 *   - Appending at the end is O(1) (cached tail) — building a doc this way is O(n).
 *   - A single *interior* insert/delete is O(n) — fine one-off, but building a
 *     100k doc via sequential RANDOM inserts would be O(n²).
 *   - A pathological workload where every insert shares one anchor also degrades
 *     to O(n²) (the sibling scan lengthens).
 * The single fix is an order-statistics index (treap / skip list / Fenwick over
 * visible chars) → O(log n) index↔id and positioning. Deferred by decision; this
 * file is where that upgrade would prove itself.
 */

describe("benchmark: 100k-char document", () => {
  it("append-build, random interior insert/delete, and text() stay acceptable", () => {
    const N = 100_000;
    const doc = makeDoc("bench");

    const buildStart = performance.now();
    for (let i = 0; i < N; i++) localInsert(doc, doc.length, "a", { timestamp: 0 });
    const buildMs = performance.now() - buildStart;
    expect(doc.length).toBe(N);

    const textStart = performance.now();
    const text = doc.text();
    const textMs = performance.now() - textStart;
    expect(text.length).toBe(N);

    const SAMPLES = 50;
    let insMs = 0;
    let delMs = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const insIdx = Math.floor(Math.random() * doc.length);
      const t0 = performance.now();
      localInsert(doc, insIdx, "b", { timestamp: 0 });
      insMs += performance.now() - t0;

      const delIdx = Math.floor(Math.random() * doc.length);
      const t1 = performance.now();
      localDelete(doc, delIdx);
      delMs += performance.now() - t1;
    }
    const avgInsMs = insMs / SAMPLES;
    const avgDelMs = delMs / SAMPLES;

    console.log(`\n[crdt bench] N=${N}`);
    console.log(
      `  build via append  (O(1)/op): ${buildMs.toFixed(1)} ms total  (${((buildMs / N) * 1000).toFixed(2)} µs/op)`,
    );
    console.log(`  text() materialize (O(n)):   ${textMs.toFixed(1)} ms`);
    console.log(
      `  random interior insert(O(n)): ${avgInsMs.toFixed(2)} ms/op  (avg of ${SAMPLES})`,
    );
    console.log(
      `  random interior delete(O(n)): ${avgDelMs.toFixed(2)} ms/op  (avg of ${SAMPLES})`,
    );

    expect(buildMs).toBeLessThan(10_000);
    expect(textMs).toBeLessThan(1_000);
    expect(avgInsMs).toBeLessThan(200);
    expect(avgDelMs).toBeLessThan(200);
  }, 60_000);

  it("applying a 20k remote-op batch integrates in roughly linear time", () => {
    // Generate 20k append ops on a source replica, then measure integrating them
    // fresh on another replica (each insert: O(1) lookup + O(1) sibling scan here).
    const src = makeDoc("src");
    const ops = Array.from({ length: 20_000 }, () =>
      localInsert(src, src.length, "z", { timestamp: 0 }),
    );

    const dst = makeDoc("dst");
    const start = performance.now();
    applyAll(dst, ops);
    const ms = performance.now() - start;

    expect(dst.length).toBe(20_000);
    console.log(`  applyRemote 20k append ops:  ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(5_000);
  }, 60_000);
});
