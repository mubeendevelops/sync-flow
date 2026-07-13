/**
 * Structural subset of the `redis` client that the rest of the app depends on.
 * Route/service code should import this type, never `redis` directly, so a fake
 * can be swapped in for tests without touching call sites.
 */
export interface CacheClient {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}
