import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import type pg from "pg";
import { createApp } from "../app.js";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import type { CacheClient } from "../cache/types.js";

const fakeCache: CacheClient = {
  ping: async () => "PONG",
  quit: async () => "OK",
};

const AUTH_CONFIG = {
  jwtAccessSecret: "test-access-secret-0123456789",
  jwtRefreshSecret: "test-refresh-secret-0123456789",
  jwtAccessTtlSeconds: 900,
  jwtRefreshTtlSeconds: 604800,
  cookieDomain: "localhost",
  secureCookies: false,
  authRateLimit: { windowMs: 60_000, max: 1000 },
};

let userCounter = 0;

describe("documents routes", () => {
  let pool: pg.Pool;
  let server: import("node:http").Server;
  let app: string;

  beforeAll(async () => {
    pool = await setupTestDb();
    const expressApp = createApp({
      logger: pino({ level: "silent" }),
      db: pool,
      cache: fakeCache,
      corsOrigin: "http://localhost:3000",
      auth: AUTH_CONFIG,
    });
    await new Promise<void>((resolve) => {
      server = expressApp.listen(0, "localhost", () => resolve());
    });
    const { port } = server.address() as import("node:net").AddressInfo;
    app = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function createUser() {
    userCounter += 1;
    const n = userCounter;
    const agent = request.agent(app);
    const res = await agent.post("/api/v1/auth/signup").send({
      username: `user${n}`,
      email: `user${n}@example.com`,
      password: "Correct-Horse-9!",
      displayName: `User ${n}`,
    });
    return { agent, userId: res.body.user.id as string, email: `user${n}@example.com` as string };
  }

  async function createDocument(agent: ReturnType<typeof request.agent>, title = "My Doc") {
    const res = await agent.post("/api/v1/documents").send({ title });
    return res.body.document as { id: string; title: string; ownerId: string; isPublic: boolean };
  }

  describe("POST /api/v1/documents", () => {
    it("creates a document with the creator as owner and version 0", async () => {
      const { agent, userId } = await createUser();
      const createRes = await agent.post("/api/v1/documents").send({ title: "My Doc" });

      expect(createRes.status).toBe(201);
      expect(createRes.body.document).toMatchObject({
        title: "My Doc",
        ownerId: userId,
        isPublic: false,
      });

      const detailRes = await agent.get(`/api/v1/documents/${createRes.body.document.id}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.version).toBe(0);
      expect(detailRes.body.members).toEqual([]);
      expect(detailRes.body.owner.id).toBe(userId);
    });

    it("rejects an empty title", async () => {
      const { agent } = await createUser();
      const res = await agent.post("/api/v1/documents").send({ title: "" });
      expect(res.status).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await request(app).post("/api/v1/documents").send({ title: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/documents", () => {
    it("lists only documents the user owns or is a member of", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      await createDocument(owner.agent, "Owner's Doc");

      const ownerList = await owner.agent.get("/api/v1/documents");
      expect(ownerList.body.documents).toHaveLength(1);

      const strangerList = await stranger.agent.get("/api/v1/documents");
      expect(strangerList.body.documents).toHaveLength(0);
    });

    it("paginates with page/pageSize and reports total", async () => {
      const owner = await createUser();
      for (let i = 0; i < 5; i++) {
        await createDocument(owner.agent, `Doc ${i}`);
      }

      const page1 = await owner.agent.get("/api/v1/documents").query({ page: 1, pageSize: 2 });
      expect(page1.body.documents).toHaveLength(2);
      expect(page1.body.pagination).toEqual({ page: 1, pageSize: 2, total: 5 });

      const page3 = await owner.agent.get("/api/v1/documents").query({ page: 3, pageSize: 2 });
      expect(page3.body.documents).toHaveLength(1);
    });
  });

  describe("GET /api/v1/documents/:id", () => {
    it("returns 404 (not 403) for a non-member on a private document", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await stranger.agent.get(`/api/v1/documents/${doc.id}`);
      expect(res.status).toBe(404);
    });

    it("allows any authenticated user to view a public document", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.patch(`/api/v1/documents/${doc.id}`).send({ isPublic: true });

      const res = await stranger.agent.get(`/api/v1/documents/${doc.id}`);
      expect(res.status).toBe(200);
    });

    it("returns 404 for a well-formed but nonexistent document id", async () => {
      const owner = await createUser();
      const res = await owner.agent.get("/api/v1/documents/00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/v1/documents/:id", () => {
    it("lets the owner rename and toggle isPublic", async () => {
      const owner = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await owner.agent
        .patch(`/api/v1/documents/${doc.id}`)
        .send({ title: "Renamed", isPublic: true });

      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({ title: "Renamed", isPublic: true });
    });

    it("forbids an editor member from patching (403)", async () => {
      const owner = await createUser();
      const editor = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: editor.email,
        role: "editor",
      });

      const res = await editor.agent.patch(`/api/v1/documents/${doc.id}`).send({ title: "Hacked" });
      expect(res.status).toBe(403);
    });

    it("returns 404 for a non-member, not 403", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await stranger.agent.patch(`/api/v1/documents/${doc.id}`).send({ title: "Nope" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/documents/:id", () => {
    it("is owner-only", async () => {
      const owner = await createUser();
      const editor = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: editor.email,
        role: "editor",
      });

      const editorAttempt = await editor.agent.delete(`/api/v1/documents/${doc.id}`);
      expect(editorAttempt.status).toBe(403);

      const ownerAttempt = await owner.agent.delete(`/api/v1/documents/${doc.id}`);
      expect(ownerAttempt.status).toBe(204);

      const getAfterDelete = await owner.agent.get(`/api/v1/documents/${doc.id}`);
      expect(getAfterDelete.status).toBe(404);
    });
  });

  describe("POST /api/v1/documents/:id/invite", () => {
    it("adds a member with the given role", async () => {
      const owner = await createUser();
      const invitee = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await owner.agent
        .post(`/api/v1/documents/${doc.id}/invite`)
        .send({ email: invitee.email, role: "viewer" });

      expect(res.status).toBe(201);
      expect(res.body.member).toMatchObject({ userId: invitee.userId, role: "viewer" });

      const detail = await owner.agent.get(`/api/v1/documents/${doc.id}`);
      expect(detail.body.members).toHaveLength(1);
    });

    it("updates the role on re-invite instead of erroring", async () => {
      const owner = await createUser();
      const invitee = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: invitee.email,
        role: "viewer",
      });

      const res = await owner.agent
        .post(`/api/v1/documents/${doc.id}/invite`)
        .send({ email: invitee.email, role: "editor" });

      expect(res.status).toBe(201);
      expect(res.body.member.role).toBe("editor");
    });

    it("is owner-only (editor cannot invite)", async () => {
      const owner = await createUser();
      const editor = await createUser();
      const another = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: editor.email,
        role: "editor",
      });

      const res = await editor.agent
        .post(`/api/v1/documents/${doc.id}/invite`)
        .send({ email: another.email, role: "viewer" });
      expect(res.status).toBe(403);
    });

    it("404s when the invited email has no account", async () => {
      const owner = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await owner.agent
        .post(`/api/v1/documents/${doc.id}/invite`)
        .send({ email: "nobody@example.com", role: "viewer" });
      expect(res.status).toBe(404);
    });

    it("409s when inviting the document's own owner", async () => {
      const owner = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await owner.agent
        .post(`/api/v1/documents/${doc.id}/invite`)
        .send({ email: owner.email, role: "editor" });
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /api/v1/documents/:id/members/:userId", () => {
    it("lets the owner remove a member", async () => {
      const owner = await createUser();
      const member = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: member.email,
        role: "viewer",
      });

      const res = await owner.agent.delete(`/api/v1/documents/${doc.id}/members/${member.userId}`);
      expect(res.status).toBe(204);

      const detail = await owner.agent.get(`/api/v1/documents/${doc.id}`);
      expect(detail.body.members).toHaveLength(0);
    });

    it("refuses to remove the document owner", async () => {
      const owner = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await owner.agent.delete(`/api/v1/documents/${doc.id}/members/${owner.userId}`);
      expect(res.status).toBe(400);
    });

    it("is owner-only", async () => {
      const owner = await createUser();
      const editor = await createUser();
      const viewer = await createUser();
      const doc = await createDocument(owner.agent);
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: editor.email,
        role: "editor",
      });
      await owner.agent.post(`/api/v1/documents/${doc.id}/invite`).send({
        email: viewer.email,
        role: "viewer",
      });

      const res = await editor.agent.delete(`/api/v1/documents/${doc.id}/members/${viewer.userId}`);
      expect(res.status).toBe(403);
    });

    it("404s for a user who isn't a member", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await owner.agent.delete(
        `/api/v1/documents/${doc.id}/members/${stranger.userId}`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/v1/documents/:id/operations", () => {
    it("paginates the operation log by cursor", async () => {
      const owner = await createUser();
      const doc = await createDocument(owner.agent);

      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO document_operations
             (document_id, user_id, op_type, char_id, after_id, value, replica_id, lamport_clock)
           VALUES ($1, $2, 'insert', $3, 'ROOT', $4, $5, $6)`,
          [doc.id, owner.userId, `${i + 1}@replica`, String(i), owner.userId, i + 1],
        );
      }

      const firstPage = await owner.agent
        .get(`/api/v1/documents/${doc.id}/operations`)
        .query({ limit: 2 });
      expect(firstPage.body.operations).toHaveLength(2);
      expect(firstPage.body.nextCursor).toBeTruthy();

      const secondPage = await owner.agent
        .get(`/api/v1/documents/${doc.id}/operations`)
        .query({ limit: 2, cursor: firstPage.body.nextCursor });
      expect(secondPage.body.operations).toHaveLength(1);
      expect(secondPage.body.nextCursor).toBeNull();
    });

    it("returns 404 for a non-member on a private document", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const doc = await createDocument(owner.agent);

      const res = await stranger.agent.get(`/api/v1/documents/${doc.id}/operations`);
      expect(res.status).toBe(404);
    });
  });
});
