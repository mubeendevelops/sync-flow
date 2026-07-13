/**
 * Structural subset of `pg.Pool` that the rest of the app depends on.
 * Route/service code should import this type, never `pg` directly, so a fake
 * can be swapped in for tests without touching call sites.
 */
export interface DbClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
