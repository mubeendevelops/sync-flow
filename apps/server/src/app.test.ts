import { describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "./app.js";
import type { DbClient } from "./db/types.js";
import type { CacheClient } from "./cache/types.js";

const fakeDb: DbClient = {
  query: async () => ({ rows: [] }),
};

const fakeCache: CacheClient = {
  ping: async () => "PONG",
  quit: async () => "OK",
};

function buildTestApp(overrides: { db?: DbClient; cache?: CacheClient } = {}) {
  return createApp({
    logger: pino({ level: "silent" }),
    db: overrides.db ?? fakeDb,
    cache: overrides.cache ?? fakeCache,
    corsOrigin: "http://localhost:3000",
    auth: {
      jwtAccessSecret: "test-access-secret-0123456789",
      jwtRefreshSecret: "test-refresh-secret-0123456789",
      jwtAccessTtlSeconds: 900,
      jwtRefreshTtlSeconds: 604800,
      cookieDomain: "localhost",
      secureCookies: false,
      authRateLimit: { windowMs: 60_000, max: 1000 },
    },
  });
}

describe("createApp", () => {
  it("GET /health returns 200 ok", async () => {
    const res = await request(buildTestApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /ready returns 503 when a dependency is unreachable", async () => {
    const app = buildTestApp({
      db: {
        query: async () => {
          throw new Error("connection refused");
        },
      },
    });

    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
  });

  it("unknown routes return an RFC 7807 problem+json 404", async () => {
    const res = await request(buildTestApp()).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({ status: 404, title: "Not Found" });
  });
});
