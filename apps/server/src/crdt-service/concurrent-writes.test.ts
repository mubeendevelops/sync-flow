import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ROOT, encodeId, OP_VERSION, type InsertOp } from "@sync-flow/crdt";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { seedUserAndDocument } from "../test/fixtures.js";
import { appendOperations, type PendingOp } from "./op-log.repo.js";

/**
 * The version-assignment stress test the task calls for: hammer the append path
 * from many connections at once and assert that `seq` (the version) is never
 * duplicated and no op is lost. This is what justifies "BIGSERIAL sequence, no
 * lock, no retry" — the sequence alone must survive this.
 */
describe("concurrent op version assignment", () => {
  // A pool with real connection-level concurrency, so many INSERTs hit nextval at once.
  let pool: pg.Pool;

  beforeAll(async () => {
    await setupTestDb().then((p) => p.end()); // ensure DB exists + migrated
    pool = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ??
        "postgresql://syncflow:syncflow_dev_password@localhost:5434/syncflow_test",
      max: 16,
    });
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  function insertOp(replicaId: string, clock: number): InsertOp {
    return {
      type: "insert",
      charId: { clock, replicaId },
      afterId: ROOT,
      value: "x",
      authorId: replicaId,
      timestamp: 0,
      opVersion: OP_VERSION,
    };
  }

  it("assigns a unique version to every op under heavy concurrent writes, losing none", async () => {
    const { userId, documentId } = await seedUserAndDocument(pool);

    const TASKS = 40; // distinct "connections"/replicas hammering at once
    const OPS_PER_TASK = 25; // 1000 ops total, each a separate racing INSERT
    const total = TASKS * OPS_PER_TASK;

    // Each task = one replica; clock increments per op → every char_id is globally unique.
    const tasks = Array.from({ length: TASKS }, async () => {
      const replicaId = randomUUID();
      const results: number[] = [];
      const generated: string[] = [];
      for (let k = 1; k <= OPS_PER_TASK; k++) {
        const op = insertOp(replicaId, k);
        generated.push(encodeId(op.charId));
        const batch: PendingOp[] = [{ op, userId }];
        const [persisted] = await appendOperations(pool, documentId, batch);
        results.push(persisted!.seq);
      }
      return { results, generated };
    });

    const settled = await Promise.all(tasks);
    const returnedSeqs = settled.flatMap((t) => t.results);
    const generatedCharIds = settled.flatMap((t) => t.generated);

    // 1. No op lost at the app layer: we got exactly `total` seqs back.
    expect(returnedSeqs).toHaveLength(total);
    // 2. No duplicate versions handed out.
    expect(new Set(returnedSeqs).size).toBe(total);

    // 3. The database agrees: exactly `total` rows, all seqs distinct.
    const { rows } = await pool.query<{ c: string; d: string; ids: string }>(
      `SELECT COUNT(*)::text AS c,
              COUNT(DISTINCT seq)::text AS d,
              COUNT(DISTINCT char_id)::text AS ids
       FROM document_operations WHERE document_id = $1`,
      [documentId],
    );
    expect(Number(rows[0]!.c)).toBe(total); // no lost rows
    expect(Number(rows[0]!.d)).toBe(total); // no duplicate versions in the table
    // 4. Every generated char_id landed exactly once (losslessness by identity).
    expect(Number(rows[0]!.ids)).toBe(total);
    expect(new Set(generatedCharIds).size).toBe(total);
  }, 30_000);

  it("keeps versions unique across multi-op batches racing single-op writes", async () => {
    const { userId, documentId } = await seedUserAndDocument(pool);

    // Mix batch shapes so the sequence is exercised by both wide and narrow INSERTs.
    const tasks = Array.from({ length: 20 }, async (_v, t) => {
      const replicaId = randomUUID();
      const batchSize = (t % 5) + 1; // 1..5 ops per INSERT
      const seqs: number[] = [];
      for (let round = 0; round < 10; round++) {
        const batch: PendingOp[] = Array.from({ length: batchSize }, (_w, i) => ({
          op: insertOp(replicaId, round * batchSize + i + 1),
          userId,
        }));
        const persisted = await appendOperations(pool, documentId, batch);
        for (const p of persisted) seqs.push(p.seq);
      }
      return seqs;
    });

    const allSeqs = (await Promise.all(tasks)).flat();
    expect(new Set(allSeqs).size).toBe(allSeqs.length);

    const { rows } = await pool.query<{ c: string; d: string }>(
      `SELECT COUNT(*)::text AS c, COUNT(DISTINCT seq)::text AS d
       FROM document_operations WHERE document_id = $1`,
      [documentId],
    );
    expect(Number(rows[0]!.c)).toBe(allSeqs.length);
    expect(Number(rows[0]!.d)).toBe(allSeqs.length);
  }, 30_000);
});
