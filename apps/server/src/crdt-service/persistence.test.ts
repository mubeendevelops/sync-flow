import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  RGADocument,
  localInsert,
  localDelete,
  type DocumentIdentity,
  type Op,
} from "@sync-flow/crdt";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { seedUserAndDocument } from "../test/fixtures.js";
import { createDocumentWithInitialSnapshot } from "../documents/documents.repo.js";
import { appendOperations, type PendingOp } from "./op-log.repo.js";
import { hydrateDocument } from "./hydrate.js";
import { DocumentStore } from "./document-store.js";
import { type CrdtStateCache } from "./cache.js";

/** In-memory CrdtStateCache so we can assert cache hits and force the Postgres path. */
function makeCache(): CrdtStateCache & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
      return "OK";
    },
    del: async (k) => (data.delete(k) ? 1 : 0),
  };
}

const identity = (): DocumentIdentity => ({ replicaId: randomUUID(), authorId: "server" });

/** Build ops for `text` on a scratch client doc, mimicking a real editor's inserts. */
function typeText(text: string): Op[] {
  const doc = new RGADocument({ replicaId: randomUUID(), authorId: "client" });
  return [...text].map((ch, i) => localInsert(doc, i, ch, { timestamp: 0 }));
}

describe("crdt persistence layer (real Postgres)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await setupTestDb();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("hydrates a document by replaying its persisted op log", async () => {
    const { userId, documentId } = await seedUserAndDocument(pool);
    const ops = typeText("hello world");
    const batch: PendingOp[] = ops.map((op) => ({ op, userId }));
    await appendOperations(pool, documentId, batch);

    const cache = makeCache();
    const { doc, seq } = await hydrateDocument({ db: pool, cache }, documentId, identity());

    expect(doc.text()).toBe("hello world");
    expect(seq).toBeGreaterThan(0);
    // Load populated the hot cache for next time.
    expect(cache.data.size).toBe(1);
  });

  it("applies ops that landed after the cached snapshot (stale cache still converges)", async () => {
    const { userId, documentId } = await seedUserAndDocument(pool);

    // One client doc for the whole test so anchors are consistent across batches.
    const client = new RGADocument({ replicaId: randomUUID(), authorId: "client" });
    const abc = [..."abc"].map((ch, i) => localInsert(client, i, ch, { timestamp: 0 }));
    await appendOperations(
      pool,
      documentId,
      abc.map((op) => ({ op, userId })),
    );

    const cache = makeCache();
    const first = await hydrateDocument({ db: pool, cache }, documentId, identity());
    expect(first.doc.text()).toBe("abc");

    // 'd' anchors to the real persisted 'c'; it persists to Postgres but the cache
    // is now behind by this op — hydrate must replay it on top of the cached state.
    const d = localInsert(client, 3, "d", { timestamp: 0 });
    await appendOperations(pool, documentId, [{ op: d, userId }]);

    const second = await hydrateDocument({ db: pool, cache }, documentId, identity());
    expect(second.doc.text()).toBe("abcd");
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it("DocumentStore persists edits, snapshots on policy, and reloads to identical state", async () => {
    const { userId, documentId } = await seedUserAndDocument(pool);
    const cache = makeCache();

    const store = await DocumentStore.load({
      db: pool,
      cache,
      documentId,
      identity: identity(),
      policy: { everyOps: 3, everyMs: 30_000 }, // snapshot quickly for the test
    });

    // Type "hello" — caller applies to the doc, then hands the op to persist().
    for (const ch of "hello") {
      const op = localInsert(store.doc, store.doc.length, ch, { timestamp: 0 });
      store.persist(op, userId);
    }
    await store.flush();

    // Policy (everyOps: 3) must have produced at least one snapshot.
    const snap = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM document_snapshots WHERE document_id = $1`,
      [documentId],
    );
    expect(Number(snap.rows[0]!.c)).toBeGreaterThan(0);

    // Reload from the SAME cache (hot path).
    const reloadedHot = await DocumentStore.load({
      db: pool,
      cache,
      documentId,
      identity: identity(),
    });
    expect(reloadedHot.doc.text()).toBe("hello");

    // Reload from a COLD cache (forces snapshot + op-log replay from Postgres).
    const reloadedCold = await DocumentStore.load({
      db: pool,
      cache: makeCache(),
      documentId,
      identity: identity(),
    });
    expect(reloadedCold.doc.text()).toBe("hello");
  });

  it("forces a final snapshot on close (last-client-disconnect)", async () => {
    const { userId, documentId } = await seedUserAndDocument(pool);
    const cache = makeCache();

    const store = await DocumentStore.load({
      db: pool,
      cache,
      documentId,
      identity: identity(),
      policy: { everyOps: 1000, everyMs: 1_000_000 }, // never triggers on its own
    });

    for (const ch of "bye") {
      const op = localInsert(store.doc, store.doc.length, ch, { timestamp: 0 });
      store.persist(op, userId);
    }
    // Delete the 'e' so a tombstone is exercised through the snapshot too.
    store.persist(localDelete(store.doc, 2), userId);

    await store.close(); // drains writer + forces a snapshot despite the loose policy

    const { rows } = await pool.query<{ plain_text: string; seq: string }>(
      `SELECT plain_text, seq FROM document_snapshots
       WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
      [documentId],
    );
    expect(rows[0]!.plain_text).toBe("by");
    expect(Number(rows[0]!.seq)).toBeGreaterThan(0);

    const reloaded = await DocumentStore.load({
      db: pool,
      cache: makeCache(),
      documentId,
      identity: identity(),
    });
    expect(reloaded.doc.text()).toBe("by");
  });

  it("hydrates the empty version-0 snapshot written at document creation", async () => {
    const { userId } = await seedUserAndDocument(pool);
    const created = await createDocumentWithInitialSnapshot(pool, {
      title: "Fresh",
      ownerId: userId,
    });

    const { doc, seq } = await hydrateDocument(
      { db: pool, cache: makeCache() },
      created.id,
      identity(),
    );
    expect(doc.text()).toBe("");
    expect(seq).toBe(0);
  });
});
