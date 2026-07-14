import pg from "pg";

/**
 * The only place `pg.Pool` is constructed — everywhere else takes a `DbClient`.
 * Untested by design: every other module depends on the `DbClient` interface and is
 * exercised against a real pool from `test-db.ts`, so testing this one-line factory
 * would only be asserting that `pg.Pool`'s own constructor runs — no branches, no
 * app logic. Coverage gap accepted (see PLAN.md "Load Test Results" hardening notes).
 */
export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
