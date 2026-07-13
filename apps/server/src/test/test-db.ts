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

function runMigrations(): void {
  execFileSync("node_modules/.bin/node-pg-migrate", ["up", "-j", "sql"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}

/** Ensures the test database exists and is migrated, and returns a pool connected to it. */
export async function setupTestDb(): Promise<pg.Pool> {
  await ensureDatabaseExists();
  runMigrations();
  return new pg.Pool({ connectionString: TEST_DATABASE_URL });
}

/** Clears all auth-relevant rows between tests. CASCADE covers refresh_tokens + any doc rows. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
}
