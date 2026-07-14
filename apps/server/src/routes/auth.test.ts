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

function extractCookie(setCookieHeaders: string[] | undefined, name: string): string | undefined {
  const header = setCookieHeaders?.find((c) => c.startsWith(`${name}=`));
  return header?.split(";")[0]?.split("=").slice(1).join("=");
}

function validSignupBody(overrides: Partial<Record<string, string>> = {}) {
  return {
    username: "alice",
    email: "alice@example.com",
    password: "Correct-Horse-9!",
    displayName: "Alice Anderson",
    ...overrides,
  };
}

describe("auth routes", () => {
  let pool: pg.Pool;
  let server: import("node:http").Server;
  let app: string; // base URL — see note below

  beforeAll(async () => {
    pool = await setupTestDb();
    const expressApp = createApp({
      logger: pino({ level: "silent" }),
      db: pool,
      cache: fakeCache,
      corsOrigin: "http://localhost:3000",
      auth: AUTH_CONFIG,
    });
    // Cookies are set with Domain=localhost (matching real dev topology: web on
    // localhost:3000, server on localhost:4000). supertest's default `request(app)` connects
    // via 127.0.0.1, which doesn't domain-match "localhost" and makes the cookie jar correctly
    // drop the cookie — so we listen on "localhost" explicitly and hit it by URL instead, the
    // same way a real browser would.
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

  describe("POST /api/v1/auth/signup", () => {
    it("creates a user, logs them in, and never returns the password hash", async () => {
      const res = await request(app).post("/api/v1/auth/signup").send(validSignupBody());

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({
        username: "alice",
        email: "alice@example.com",
        displayName: "Alice Anderson",
      });
      expect(res.body.user.presenceColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(JSON.stringify(res.body)).not.toContain("password");

      const cookies = res.headers["set-cookie"] as unknown as string[];
      expect(extractCookie(cookies, "access_token")).toBeTruthy();
      expect(extractCookie(cookies, "refresh_token")).toBeTruthy();
      expect(extractCookie(cookies, "csrf_token")).toBeTruthy();
      // secureCookies:false in this test config (see AUTH_CONFIG) — real prod/dev config uses
      // secure:true + SameSite=None, see cookies.ts.
      expect(cookies.find((c) => c.startsWith("access_token="))).toMatch(/SameSite=Lax/i);
      expect(cookies.find((c) => c.startsWith("access_token="))).toMatch(/HttpOnly/i);
    });

    it("rejects a duplicate email with 409", async () => {
      await request(app).post("/api/v1/auth/signup").send(validSignupBody());
      const res = await request(app)
        .post("/api/v1/auth/signup")
        .send(validSignupBody({ username: "alice2" }));
      expect(res.status).toBe(409);
    });

    it("rejects a duplicate username with 409", async () => {
      await request(app).post("/api/v1/auth/signup").send(validSignupBody());
      const res = await request(app)
        .post("/api/v1/auth/signup")
        .send(validSignupBody({ email: "alice2@example.com" }));
      expect(res.status).toBe(409);
    });

    it("rejects a weak password with 400", async () => {
      const res = await request(app)
        .post("/api/v1/auth/signup")
        .send(validSignupBody({ password: "weak" }));
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/auth/login", () => {
    it("logs in with correct credentials", async () => {
      await request(app).post("/api/v1/auth/signup").send(validSignupBody());
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "alice@example.com", password: "Correct-Horse-9!" });

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("alice");
      expect(res.headers["set-cookie"]).toBeTruthy();
    });

    it("rejects a wrong password with the same status/message as an unknown email", async () => {
      await request(app).post("/api/v1/auth/signup").send(validSignupBody());

      const wrongPassword = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "alice@example.com", password: "totally-wrong-1A!" });
      const unknownEmail = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.com", password: "totally-wrong-1A!" });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("returns 401 without a session", async () => {
      const res = await request(app).get("/api/v1/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns the current user with a valid session", async () => {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/signup").send(validSignupBody());

      const res = await agent.get("/api/v1/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("alice");
    });

    it("returns 401 if the user was deleted after the access token was issued", async () => {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/signup").send(validSignupBody());
      await pool.query("DELETE FROM users WHERE username = $1", ["alice"]);

      const res = await agent.get("/api/v1/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe("User no longer exists");
    });
  });

  describe("POST /api/v1/auth/logout", () => {
    it("requires a valid CSRF header", async () => {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/signup").send(validSignupBody());

      const res = await agent.post("/api/v1/auth/logout");
      expect(res.status).toBe(403);
    });

    it("clears the session cookies", async () => {
      const agent = request.agent(app);
      const signupRes = await agent.post("/api/v1/auth/signup").send(validSignupBody());
      const csrfToken = extractCookie(
        signupRes.headers["set-cookie"] as unknown as string[],
        "csrf_token",
      );

      const logoutRes = await agent.post("/api/v1/auth/logout").set("X-CSRF-Token", csrfToken!);
      expect(logoutRes.status).toBe(204);

      // Cookies were cleared client-side, so the agent has nothing left to send at all — any
      // follow-up state-changing request now fails CSRF validation before reaching route logic.
      const refreshRes = await agent.post("/api/v1/auth/refresh").set("X-CSRF-Token", csrfToken!);
      expect(refreshRes.status).toBe(403);
    });

    it("revokes the refresh token server-side, independent of client cookie clearing", async () => {
      const agent = request.agent(app);
      const signupRes = await agent.post("/api/v1/auth/signup").send(validSignupBody());
      const setCookie = signupRes.headers["set-cookie"] as unknown as string[];
      const csrfToken = extractCookie(setCookie, "csrf_token");
      const refreshToken = extractCookie(setCookie, "refresh_token");

      const logoutRes = await agent.post("/api/v1/auth/logout").set("X-CSRF-Token", csrfToken!);
      expect(logoutRes.status).toBe(204);

      // Replay the pre-logout refresh/csrf cookie values directly (bypassing the agent's jar,
      // which already dropped them) to prove the token is dead server-side, not just forgotten
      // client-side.
      const reuseRes = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", [`refresh_token=${refreshToken}`, `csrf_token=${csrfToken}`])
        .set("X-CSRF-Token", csrfToken!);
      expect(reuseRes.status).toBe(401);
    });

    it("still succeeds with no refresh_token cookie to revoke (access + CSRF cookies only)", async () => {
      const signupRes = await request(app).post("/api/v1/auth/signup").send(validSignupBody());
      const setCookie = signupRes.headers["set-cookie"] as unknown as string[];
      const accessToken = extractCookie(setCookie, "access_token");
      const csrfToken = extractCookie(setCookie, "csrf_token");

      const logoutRes = await request(app)
        .post("/api/v1/auth/logout")
        .set("Cookie", [`access_token=${accessToken}`, `csrf_token=${csrfToken}`])
        .set("X-CSRF-Token", csrfToken!);
      expect(logoutRes.status).toBe(204);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("rotates the refresh token and issues a new access token", async () => {
      const agent = request.agent(app);
      const signupRes = await agent.post("/api/v1/auth/signup").send(validSignupBody());
      const csrfToken = extractCookie(
        signupRes.headers["set-cookie"] as unknown as string[],
        "csrf_token",
      );
      const originalRefreshToken = extractCookie(
        signupRes.headers["set-cookie"] as unknown as string[],
        "refresh_token",
      );

      const refreshRes = await agent.post("/api/v1/auth/refresh").set("X-CSRF-Token", csrfToken!);
      expect(refreshRes.status).toBe(200);

      const newRefreshToken = extractCookie(
        refreshRes.headers["set-cookie"] as unknown as string[],
        "refresh_token",
      );
      expect(newRefreshToken).toBeTruthy();
      expect(newRefreshToken).not.toBe(originalRefreshToken);
    });

    it("detects reuse of a rotated-out refresh token and revokes the whole session family", async () => {
      const agent = request.agent(app);
      const signupRes = await agent.post("/api/v1/auth/signup").send(validSignupBody());
      const csrfToken = extractCookie(
        signupRes.headers["set-cookie"] as unknown as string[],
        "csrf_token",
      );
      const originalRefreshToken = extractCookie(
        signupRes.headers["set-cookie"] as unknown as string[],
        "refresh_token",
      );

      // First refresh rotates the token (this succeeds and is the "legitimate" use).
      const firstRefresh = await agent.post("/api/v1/auth/refresh").set("X-CSRF-Token", csrfToken!);
      expect(firstRefresh.status).toBe(200);
      const rotatedRefreshToken = extractCookie(
        firstRefresh.headers["set-cookie"] as unknown as string[],
        "refresh_token",
      );

      // Replaying the original (now-revoked) token simulates a stolen token being reused.
      const reuseRes = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", [`refresh_token=${originalRefreshToken}`, `csrf_token=${csrfToken}`])
        .set("X-CSRF-Token", csrfToken!);
      expect(reuseRes.status).toBe(401);

      // The entire family — including the token issued by the "legitimate" rotation — is now dead.
      const rotatedNowRevoked = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", [`refresh_token=${rotatedRefreshToken}`, `csrf_token=${csrfToken}`])
        .set("X-CSRF-Token", csrfToken!);
      expect(rotatedNowRevoked.status).toBe(401);
    });

    it("requires a valid CSRF header", async () => {
      const agent = request.agent(app);
      await agent.post("/api/v1/auth/signup").send(validSignupBody());

      const res = await agent.post("/api/v1/auth/refresh");
      expect(res.status).toBe(403);
    });
  });
});
