/**
 * Runs once before the whole suite (and before the webServer entries in playwright.config.ts
 * are considered ready — see that file). Makes sure:
 *   1. Postgres/Redis (docker-compose) are reachable — spun up on demand if not.
 *   2. A dedicated `syncflow_e2e` database exists and is migrated to the latest schema.
 *   3. The baseline seed data (apps/server/src/seed.ts) is loaded — re-runnable, so this is
 *      safe on repeated runs. Individual specs still create their own users/documents on top
 *      of this (see fixtures.ts) rather than depending on the fixed seed rows, so parallel
 *      workers never collide with each other.
 *
 * This file intentionally does NOT start the server/web processes — that's Playwright's own
 * `webServer` array, which already gives us readiness polling, log capture, and teardown for
 * free; duplicating that here would just be a worse version of it.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { E2E_DATABASE_URL } from "./env.ts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SERVER_ROOT = path.join(REPO_ROOT, "apps/server");

function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgres(maintenanceUrl: string): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pool = new pg.Pool({ connectionString: maintenanceUrl, connectionTimeoutMillis: 2000 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (err) {
      await pool.end().catch(() => undefined);
      if (attempt === maxAttempts) {
        throw new Error(
          `Postgres never became reachable at ${maintenanceUrl} — is \`docker compose up -d\` running?`,
          { cause: err },
        );
      }
      await sleep(500);
    }
  }
}

async function ensureDatabaseExists(): Promise<void> {
  const dbName = new URL(E2E_DATABASE_URL).pathname.slice(1);
  const maintenanceUrl = withDatabase(E2E_DATABASE_URL, "postgres");
  await waitForPostgres(maintenanceUrl);

  const maintenancePool = new pg.Pool({ connectionString: maintenanceUrl });
  try {
    const { rows } = await maintenancePool.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (rows.length === 0) {
      // dbName is the fixed "syncflow_e2e" constant, never user input — CREATE DATABASE can't
      // take a bind parameter for an identifier, so this is the standard escape hatch.
      await maintenancePool.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await maintenancePool.end();
  }
}

function runMigrations(): void {
  execFileSync("node_modules/.bin/node-pg-migrate", ["up", "-j", "sql"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  });
}

function runSeed(): void {
  execFileSync("node_modules/.bin/tsx", ["src/seed.ts"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  });
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabaseExists();
  runMigrations();
  runSeed();
}
