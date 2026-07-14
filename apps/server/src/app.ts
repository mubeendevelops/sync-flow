import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { DbClient } from "./db/types.js";
import type { CacheClient } from "./cache/types.js";
import { createHealthRouter } from "./routes/health.js";
import { createAuthRouter, type AuthRouterDeps } from "./routes/auth.js";
import { createDocumentsRouter, type DocumentsRestoreDeps } from "./routes/documents.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { errorHandler } from "./middleware/error-handler.js";

export interface AppDeps {
  logger: Logger;
  db: DbClient;
  cache: CacheClient;
  corsOrigin: string;
  auth: Omit<AuthRouterDeps, "db">;
  /** Realtime wiring for document restore (POST /restore); omit in tests that don't exercise it. */
  restore?: DocumentsRestoreDeps;
}

/** Pure factory: builds an Express app from injected deps, doesn't listen. Test-friendly. */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(pinoHttp({ logger: deps.logger }));
  app.use(cors({ origin: deps.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.use(createHealthRouter({ db: deps.db, cache: deps.cache }));
  app.use("/api/v1/auth", createAuthRouter({ db: deps.db, ...deps.auth }));
  app.use(
    "/api/v1/documents",
    createDocumentsRouter({
      db: deps.db,
      jwtAccessSecret: deps.auth.jwtAccessSecret,
      restore: deps.restore,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
