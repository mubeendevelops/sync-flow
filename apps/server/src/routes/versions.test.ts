/**
 * REST version-history endpoints: list, get-at-version, and owner-only restore.
 * Data is seeded through the real op-log + snapshot repos with genuine CRDT ops (so
 * reconstruction is exercised for real), and restore runs through the real
 * `performRestore` path with an in-memory room manager + a recording broadcaster.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import type pg from "pg";
import { RGADocument, localInsert, type Op } from "@sync-flow/crdt";
import { createApp } from "../app.js";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";
import { DocumentRoomManager } from "../sockets/room-manager.js";
import {
  appendOperations,
  writeSnapshot,
  type CrdtStateCache,
  type RestoreBroadcaster,
} from "../crdt-service/index.js";
import type { CacheClient } from "../cache/types.js";

const JWT_SECRET = "test-access-secret-0123456789";
const AUTH_CONFIG = {
  jwtAccessSecret: JWT_SECRET,
  jwtRefreshSecret: "test-refresh-secret-0123456789",
  jwtAccessTtlSeconds: 900,
  jwtRefreshTtlSeconds: 604800,
  cookieDomain: "localhost",
  secureCookies: false,
  authRateLimit: { windowMs: 60_000, max: 1000 },
};
const fakeCache: CacheClient = { ping: async () => "PONG", quit: async () => "OK" };

function makeStateCache(): CrdtStateCache {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
      return "OK";
    },
    del: async (k) => (m.delete(k) ? 1 : 0),
  };
}

let counter = 0;

describe("version history routes", () => {
  let pool: pg.Pool;
  let server: import("node:http").Server;
  let app: string;
  let manager: DocumentRoomManager;
  const broadcasts: { documentId: string; ops: Op[] }[] = [];
  const broadcaster: RestoreBroadcaster = {
    broadcast: (documentId, ops) => broadcasts.push({ documentId, ops }),
    publishPeers: () => undefined,
  };

  beforeAll(async () => {
    pool = await setupTestDb();
    manager = new DocumentRoomManager({
      db: pool,
      cache: makeStateCache(),
      logger: pino({ level: "silent" }),
    });
    const expressApp = createApp({
      logger: pino({ level: "silent" }),
      db: pool,
      cache: fakeCache,
      corsOrigin: "http://localhost:3000",
      auth: AUTH_CONFIG,
      restore: { manager, broadcaster },
    });
    await new Promise<void>((resolve) => {
      server = expressApp.listen(0, "localhost", () => resolve());
    });
    const { port } = server.address() as import("node:net").AddressInfo;
    app = `http://localhost:${port}`;
  });

  afterEach(async () => {
    broadcasts.length = 0;
    await manager.closeAll();
    await truncateAll(pool);
  });

  afterAll(async () => {
    await manager.closeAll();
    await pool.end();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function cookie(userId: string): string {
    return `${ACCESS_TOKEN_COOKIE}=${signAccessToken(userId, JWT_SECRET, 900)}`;
  }

  async function seedUser(color = "#3182CE"): Promise<string> {
    counter += 1;
    const n = counter;
    const {
      rows: [u],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, $4) RETURNING id`,
      [`ver-${n}@example.com`, `User ${n}`, `veruser${n}`, color],
    );
    return u!.id;
  }

  async function seedDoc(ownerId: string): Promise<string> {
    counter += 1;
    const {
      rows: [d],
    } = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [`Doc ${counter}`, ownerId],
    );
    await pool.query(
      `INSERT INTO document_snapshots (document_id, seq, state, plain_text)
       VALUES ($1, 0, '{"v":1,"clock":0,"chars":[]}'::jsonb, '')`,
      [d!.id],
    );
    return d!.id;
  }

  /** Type text onto `doc` (continuing its clock) and persist the ops as `userId`. */
  async function commit(
    documentId: string,
    doc: RGADocument,
    text: string,
    userId: string,
  ): Promise<number> {
    const ops: Op[] = [];
    for (const ch of [...text]) ops.push(localInsert(doc, doc.length, ch));
    const persisted = await appendOperations(
      pool,
      documentId,
      ops.map((op) => ({ op, userId })),
    );
    return persisted[persisted.length - 1]!.seq;
  }

  /**
   * A document with two versions:
   *   v1 (owner)  — text "Hello World"
   *   v2 (editor) — text "Hello World!!!"
   * plus the version-0 creation snapshot. Returns the ids + version seqs.
   */
  async function seedHistory(): Promise<{
    ownerId: string;
    editorId: string;
    documentId: string;
    v1: number;
    v2: number;
  }> {
    const ownerId = await seedUser("#3182CE");
    const editorId = await seedUser("#E53E3E");
    const documentId = await seedDoc(ownerId);
    await pool.query(
      `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [documentId, editorId],
    );

    const doc = new RGADocument({ replicaId: randomUUID(), authorId: ownerId });
    const v1 = await commit(documentId, doc, "Hello World", ownerId);
    await writeSnapshot(pool, documentId, v1, doc.toSnapshot(), doc.text());

    const v2 = await commit(documentId, doc, "!!!", editorId);
    await writeSnapshot(pool, documentId, v2, doc.toSnapshot(), doc.text());

    return { ownerId, editorId, documentId, v1, v2 };
  }

  describe("GET /:id/versions", () => {
    it("lists snapshots newest-first with preview + contributors", async () => {
      const { ownerId, editorId, documentId, v1, v2 } = await seedHistory();
      const res = await request(app)
        .get(`/api/v1/documents/${documentId}/versions`)
        .set("Cookie", cookie(ownerId));

      expect(res.status).toBe(200);
      const versions = res.body.versions as {
        version: number;
        preview: string;
        contributors: { userId: string }[];
      }[];
      expect(versions.map((v) => v.version)).toEqual([v2, v1, 0]);

      const v2Row = versions.find((v) => v.version === v2)!;
      expect(v2Row.preview).toBe("Hello World!!!");
      expect(v2Row.contributors.map((c) => c.userId)).toEqual([editorId]);

      const v1Row = versions.find((v) => v.version === v1)!;
      expect(v1Row.preview).toBe("Hello World");
      expect(v1Row.contributors.map((c) => c.userId)).toEqual([ownerId]);
    });

    it("paginates via nextCursor", async () => {
      const { ownerId, documentId, v2 } = await seedHistory();
      const first = await request(app)
        .get(`/api/v1/documents/${documentId}/versions`)
        .query({ limit: 1 })
        .set("Cookie", cookie(ownerId));
      expect(first.body.versions.map((v: { version: number }) => v.version)).toEqual([v2]);
      expect(first.body.nextCursor).toBe(String(v2));

      const second = await request(app)
        .get(`/api/v1/documents/${documentId}/versions`)
        .query({ limit: 1, cursor: first.body.nextCursor })
        .set("Cookie", cookie(ownerId));
      expect(second.body.versions).toHaveLength(1);
      expect(second.body.versions[0].version).toBeLessThan(v2);
    });

    it("404s a non-member", async () => {
      const { documentId } = await seedHistory();
      const stranger = await seedUser();
      const res = await request(app)
        .get(`/api/v1/documents/${documentId}/versions`)
        .set("Cookie", cookie(stranger));
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/versions/:version", () => {
    it("reconstructs the exact text at a version", async () => {
      const { ownerId, documentId, v1, v2 } = await seedHistory();

      const atV1 = await request(app)
        .get(`/api/v1/documents/${documentId}/versions/${v1}`)
        .set("Cookie", cookie(ownerId));
      expect(atV1.status).toBe(200);
      expect(atV1.body.text).toBe("Hello World");

      const atV2 = await request(app)
        .get(`/api/v1/documents/${documentId}/versions/${v2}`)
        .set("Cookie", cookie(ownerId));
      expect(atV2.body.text).toBe("Hello World!!!");
    });
  });

  describe("POST /:id/restore/:version", () => {
    it("restores as owner and broadcasts forward ops", async () => {
      const { ownerId, documentId, v1 } = await seedHistory();

      const res = await request(app)
        .post(`/api/v1/documents/${documentId}/restore/${v1}`)
        .set("Cookie", cookie(ownerId));

      expect(res.status).toBe(200);
      expect(res.body.restore.text).toBe("Hello World");
      expect(res.body.restore.opCount).toBeGreaterThan(0);
      expect(res.body.restore.restoredToVersion).toBe(v1);
      expect(res.body.restore.newVersion).toBeGreaterThan(v1);

      // The restore was fanned out to clients as ordinary ops.
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.ops.length).toBeGreaterThan(0);

      // Reading the doc back reconstructs the restored text (durably persisted).
      const now = await request(app)
        .get(`/api/v1/documents/${documentId}/versions/${res.body.restore.newVersion}`)
        .set("Cookie", cookie(ownerId));
      expect(now.body.text).toBe("Hello World");
    });

    it("captures a labelled restore point for one-click undo", async () => {
      const { ownerId, documentId, v1 } = await seedHistory();
      const restore = await request(app)
        .post(`/api/v1/documents/${documentId}/restore/${v1}`)
        .set("Cookie", cookie(ownerId));

      const versions = await request(app)
        .get(`/api/v1/documents/${documentId}/versions`)
        .set("Cookie", cookie(ownerId));
      const kinds = (versions.body.versions as { kind: string }[]).map((v) => v.kind);
      expect(kinds).toContain("restore_point");
      expect(kinds).toContain("post_restore");

      // Undo: restore back to the pre-restore point reproduces "Hello World!!!".
      const undo = await request(app)
        .post(`/api/v1/documents/${documentId}/restore/${restore.body.restore.restorePointVersion}`)
        .set("Cookie", cookie(ownerId));
      expect(undo.status).toBe(200);
      expect(undo.body.restore.text).toBe("Hello World!!!");
    });

    it("forbids a non-owner (editor) from restoring", async () => {
      const { editorId, documentId, v1 } = await seedHistory();
      const res = await request(app)
        .post(`/api/v1/documents/${documentId}/restore/${v1}`)
        .set("Cookie", cookie(editorId));
      expect(res.status).toBe(403);
      expect(broadcasts).toHaveLength(0);
    });

    it("400s restoring to a future version", async () => {
      const { ownerId, documentId, v2 } = await seedHistory();
      const res = await request(app)
        .post(`/api/v1/documents/${documentId}/restore/${v2 + 1000}`)
        .set("Cookie", cookie(ownerId));
      expect(res.status).toBe(400);
    });
  });
});
