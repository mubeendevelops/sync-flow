import { Router } from "express";
import type { DbClient } from "../db/types.js";
import type { CacheClient } from "../cache/types.js";

export interface HealthDeps {
  db: DbClient;
  cache: CacheClient;
}

/** Liveness/readiness — kept as plain JSON, not problem+json (these aren't API errors). */
export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/ready", async (req, res) => {
    try {
      await Promise.all([deps.db.query("SELECT 1"), deps.cache.ping()]);
      res.status(200).json({ status: "ready" });
    } catch (err) {
      req.log.warn({ err }, "readiness check failed");
      res.status(503).json({ status: "not ready" });
    }
  });

  return router;
}
