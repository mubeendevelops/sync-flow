import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimiter } from "./rate-limit.js";
import { errorHandler } from "./error-handler.js";

describe("createRateLimiter", () => {
  it("lets requests through under the limit and rejects with 429 once exceeded", async () => {
    const app = express();
    // errorHandler logs via req.log (normally pino-http); stub it since this test skips
    // the full app wiring.
    app.use((req, _res, next) => {
      (req as unknown as { log: { error: () => void; warn: () => void } }).log = {
        error: () => undefined,
        warn: () => undefined,
      };
      next();
    });
    app.use(createRateLimiter({ windowMs: 60_000, max: 2 }));
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);

    const agent = request(app);
    await agent.get("/").expect(200);
    await agent.get("/").expect(200);
    const third = await agent.get("/");
    expect(third.status).toBe(429);
    expect(third.body.title).toBe("Too Many Requests");
  });
});
