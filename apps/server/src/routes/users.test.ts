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

describe("users routes", () => {
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

  async function createUser(input: { username: string; email: string; displayName: string }) {
    const agent = request.agent(app);
    const res = await agent.post("/api/v1/auth/signup").send({
      username: input.username,
      email: input.email,
      password: "Correct-Horse-9!",
      displayName: input.displayName,
    });
    return { agent, userId: res.body.user.id as string };
  }

  describe("GET /api/v1/users/search", () => {
    it("matches by username, display name, or email substring, case-insensitively", async () => {
      const searcher = await createUser({
        username: "searcher",
        email: "searcher@example.com",
        displayName: "Searcher",
      });
      await createUser({
        username: "ada_lovelace",
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      });
      await createUser({
        username: "bob",
        email: "bob@wonderland.example",
        displayName: "Bob Brown",
      });
      await createUser({
        username: "carol",
        email: "carol@example.com",
        displayName: "Carol Chen",
      });

      const byUsername = await searcher.agent.get("/api/v1/users/search").query({ q: "ADA_LOVE" });
      expect(byUsername.body.users.map((u: { username: string }) => u.username)).toEqual([
        "ada_lovelace",
      ]);

      const byDisplayName = await searcher.agent.get("/api/v1/users/search").query({ q: "brown" });
      expect(byDisplayName.body.users.map((u: { username: string }) => u.username)).toEqual([
        "bob",
      ]);

      const byEmail = await searcher.agent.get("/api/v1/users/search").query({ q: "wonderland" });
      expect(byEmail.body.users.map((u: { username: string }) => u.username)).toEqual(["bob"]);
    });

    it("never returns the caller themselves", async () => {
      const searcher = await createUser({
        username: "findme",
        email: "findme@example.com",
        displayName: "Find Me",
      });

      const res = await searcher.agent.get("/api/v1/users/search").query({ q: "findme" });
      expect(res.body.users).toEqual([]);
    });

    it("never leaks password_hash", async () => {
      const searcher = await createUser({
        username: "searcher2",
        email: "searcher2@example.com",
        displayName: "Searcher Two",
      });
      await createUser({
        username: "target",
        email: "target@example.com",
        displayName: "Target User",
      });

      const res = await searcher.agent.get("/api/v1/users/search").query({ q: "target" });
      expect(res.body.users[0]).not.toHaveProperty("passwordHash");
      expect(res.body.users[0]).not.toHaveProperty("password_hash");
    });

    it("400s on an empty query", async () => {
      const searcher = await createUser({
        username: "searcher3",
        email: "searcher3@example.com",
        displayName: "Searcher Three",
      });
      const res = await searcher.agent.get("/api/v1/users/search").query({ q: "" });
      expect(res.status).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await request(app).get("/api/v1/users/search").query({ q: "anything" });
      expect(res.status).toBe(401);
    });
  });
});
