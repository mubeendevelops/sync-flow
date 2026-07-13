import pg from "pg";

/** The only place `pg.Pool` is constructed — everywhere else takes a `DbClient`. */
export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
