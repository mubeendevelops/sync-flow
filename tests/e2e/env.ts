/**
 * Ports and connection strings shared by playwright.config.ts (which boots the server/web
 * processes) and fixtures.ts (which talks to them). Deliberately different from the normal
 * dev ports (3000/4000) so the e2e run never collides with a `pnpm dev` you already have open,
 * and a dedicated Postgres database so it never touches your dev data.
 */

export const API_PORT = 4100;
export const WEB_PORT = 3100;

export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const WS_URL = `ws://localhost:${API_PORT}`;

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://syncflow:syncflow_dev_password@localhost:5434/syncflow_e2e";

// Same Redis instance as dev (docker-compose only runs one) — safe to share since presence/
// pubsub/rate-limit/undo state is all keyed by document/user id, and every e2e test uses
// fresh, randomly-generated ones.
export const E2E_REDIS_URL = process.env.E2E_REDIS_URL ?? "redis://localhost:6380";

// Dev's own secrets are fine to reuse here — this server instance only ever talks to the
// throwaway syncflow_e2e database, never real user data.
export const JWT_ACCESS_SECRET = "e2e_access_secret_change_me_please";
export const JWT_REFRESH_SECRET = "e2e_refresh_secret_change_me_please";
