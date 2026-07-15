import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { DbClient } from "./db/types.js";
import type { CacheClient } from "./cache/types.js";
import { createHealthRouter } from "./routes/health.js";
import { createAuthRouter, type AuthRouterDeps } from "./routes/auth.js";
import {
  createDocumentsRouter,
  type DocumentsRestoreDeps,
  type DocumentsExportDeps,
} from "./routes/documents.js";
import { createUsersRouter } from "./routes/users.js";
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
  /** Wiring for PDF export (GET /export/pdf); omit in tests that don't exercise it. */
  export?: DocumentsExportDeps;
}

/** Pure factory: builds an Express app from injected deps, doesn't listen. Test-friendly. */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    pinoHttp({
      logger: deps.logger,
      // pino-http's default req/res serializers log EVERY raw header verbatim — that
      // includes the Cookie header (carrying the httpOnly JWT access/refresh tokens and
      // the CSRF cookie), any Authorization header, and Set-Cookie on the way out. Redact
      // by path rather than dropping headers wholesale so the rest of the request/response
      // shape stays visible for debugging.
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: "[redacted]",
      },
    }),
  );
  app.use(cors({ origin: deps.corsOrigin, credentials: true }));
  // 64KB cap: generously above any real request this API accepts (documents/versions are
  // CRDT snapshots read from Postgres, never uploaded whole; the largest client payload is
  // an `edit` batch over the WS transport, not HTTP) — this just bounds the JSON body parser
  // itself against an oversized/abusive request.
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.use(createHealthRouter({ db: deps.db, cache: deps.cache }));
  app.use("/api/v1/auth", createAuthRouter({ db: deps.db, ...deps.auth }));
  app.use(
    "/api/v1/documents",
    createDocumentsRouter({
      db: deps.db,
      jwtAccessSecret: deps.auth.jwtAccessSecret,
      restore: deps.restore,
      export: deps.export,
    }),
  );
  app.use(
    "/api/v1/users",
    createUsersRouter({ db: deps.db, jwtAccessSecret: deps.auth.jwtAccessSecret }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
