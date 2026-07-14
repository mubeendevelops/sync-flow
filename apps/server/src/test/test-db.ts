import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Same instance/credentials as the dev DB in .env.example, different database — reusing the
// docker-compose postgres container that's already expected to be running for local dev.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://syncflow:syncflow_dev_password@localhost:5434/syncflow_test";

function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function ensureDatabaseExists(): Promise<void> {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const maintenancePool = new pg.Pool({
    connectionString: withDatabase(TEST_DATABASE_URL, "postgres"),
  });
  try {
    const { rows } = await maintenancePool.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (rows.length === 0) {
      // dbName is the fixed "syncflow_test" constant above, never user input — CREATE DATABASE
      // can't take a bind parameter for an identifier, so this is the standard escape hatch.
      await maintenancePool.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await maintenancePool.end();
  }
}

function runMigrationsOnce(): void {
  execFileSync("node_modules/.bin/node-pg-migrate", ["up", "-j", "sql"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Vitest runs each test file in its own worker, and every file calls setupTestDb() — node-pg-
// migrate takes a Postgres advisory lock while migrating, so concurrent workers race for it and
// the loser errors immediately instead of waiting. Once the winner finishes there's nothing left
// to migrate, so a short retry loop is enough; no need for a shared globalSetup step.
async function runMigrations(): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      runMigrationsOnce();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(300 * attempt);
    }
  }
}

/** Ensures the test database exists and is migrated, and returns a pool connected to it. */
export async function setupTestDb(): Promise<pg.Pool> {
  await ensureDatabaseExists();
  await runMigrations();
  return new pg.Pool({ connectionString: TEST_DATABASE_URL });
}

/**
 * Clears all auth-relevant rows between tests. CASCADE covers refresh_tokens + any doc rows.
 *
 * `TRUNCATE ... CASCADE` takes an ACCESS EXCLUSIVE lock, so two test-file workers cleaning
 * the shared DB at the same instant can deadlock (Postgres error 40P01). A deadlock is
 * always safe to retry — Postgres already rolled the loser back — so a short retry loop
 * makes the parallel suite deterministic without serializing the workers.
 */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 40P01 = deadlock, 40001 = serialization failure — both are retriable.
      if ((code !== "40P01" && code !== "40001") || attempt === maxAttempts) throw err;
      await sleep(50 * attempt);
    }
  }
}
