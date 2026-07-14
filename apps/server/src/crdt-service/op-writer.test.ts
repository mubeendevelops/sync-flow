import { describe, expect, it, vi } from "vitest";
import { ROOT, OP_VERSION, type InsertOp } from "@sync-flow/crdt";
import { OpWriter, type PersistFn } from "./op-writer.js";
import type { PendingOp, PersistedOp } from "./op-log.repo.js";

function op(clock: number): InsertOp {
  return {
    type: "insert",
    charId: { clock, replicaId: "r1" },
    afterId: ROOT,
    value: "x",
    authorId: "u1",
    timestamp: 0,
    opVersion: OP_VERSION,
  };
}

/** A persist fn that records each batch and assigns sequential seqs. */
function recordingPersist(): { fn: PersistFn; batches: PendingOp[][]; persisted: PersistedOp[] } {
  const batches: PendingOp[][] = [];
  const persisted: PersistedOp[] = [];
  let seq = 0;
  const fn: PersistFn = async (batch) => {
    batches.push(batch);
    const out = batch.map((p) => ({ seq: ++seq, charId: "c", op: p.op }));
    persisted.push(...out);
    return out;
  };
  return { fn, batches, persisted };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("OpWriter", () => {
  it("coalesces a burst into far fewer writes than ops (not one INSERT per op)", async () => {
    const { fn, batches } = recordingPersist();
    const writer = new OpWriter(fn, { maxBatch: 50, maxDelayMs: 250 });

    for (let i = 0; i < 120; i++) writer.enqueue(op(i), "u1");
    await writer.close();

    const totalPersisted = batches.reduce((n, b) => n + b.length, 0);
    expect(totalPersisted).toBe(120); // nothing lost
    // 120 ops must not become 120 writes; a handful of batches at most.
    expect(batches.length).toBeLessThanOrEqual(4);
  });

  it("flushes a sub-batch after the debounce window", async () => {
    const { fn, batches } = recordingPersist();
    const writer = new OpWriter(fn, { maxBatch: 50, maxDelayMs: 20 });

    writer.enqueue(op(1), "u1");
    writer.enqueue(op(2), "u1");
    expect(batches).toHaveLength(0); // below maxBatch: nothing yet

    await sleep(40);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    await writer.close();
  });

  it("flushes immediately once maxBatch is reached", async () => {
    const { fn, batches } = recordingPersist();
    const writer = new OpWriter(fn, { maxBatch: 5, maxDelayMs: 10_000 });

    for (let i = 0; i < 5; i++) writer.enqueue(op(i), "u1");
    // Give the queued microtask flush a turn — well under the 10s debounce.
    await sleep(5);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    await writer.close();
  });

  it("drains buffered ops on close (graceful shutdown loses nothing)", async () => {
    const { fn, persisted } = recordingPersist();
    const writer = new OpWriter(fn, { maxBatch: 50, maxDelayMs: 10_000 });

    writer.enqueue(op(1), "u1");
    writer.enqueue(op(2), "u1");
    writer.enqueue(op(3), "u1");
    await writer.close(); // must flush despite the long debounce

    expect(persisted).toHaveLength(3);
  });

  it("reports persisted ops via onPersisted", async () => {
    const onPersisted = vi.fn();
    const { fn } = recordingPersist();
    const writer = new OpWriter(fn, { maxBatch: 2, maxDelayMs: 10, onPersisted });

    writer.enqueue(op(1), "u1");
    writer.enqueue(op(2), "u1");
    await writer.close();

    expect(onPersisted).toHaveBeenCalled();
    const reported = onPersisted.mock.calls.flatMap((c) => c[0] as PersistedOp[]);
    expect(reported).toHaveLength(2);
  });

  it("retries a failed flush once before giving up", async () => {
    const onError = vi.fn();
    let calls = 0;
    const fn: PersistFn = async (batch) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return batch.map((p, i) => ({ seq: i + 1, charId: "c", op: p.op }));
    };
    const writer = new OpWriter(fn, { maxBatch: 50, maxDelayMs: 5, onError });

    writer.enqueue(op(1), "u1");
    await writer.close();

    expect(calls).toBe(2); // one failure + one successful retry
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a persistent failure as a data-loss event", async () => {
    const onError = vi.fn();
    const fn: PersistFn = async () => {
      throw new Error("db down");
    };
    const writer = new OpWriter(fn, { maxBatch: 50, maxDelayMs: 5, onError });

    writer.enqueue(op(1), "u1");
    await writer.close();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![1] as PendingOp[]).length).toBe(1);
  });

  it("rejects enqueue after close", async () => {
    const { fn } = recordingPersist();
    const writer = new OpWriter(fn, {});
    await writer.close();
    expect(() => writer.enqueue(op(1), "u1")).toThrow(/closed/);
  });
});
