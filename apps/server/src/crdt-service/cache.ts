/**
 * Redis hot-state cache for hydrated CRDT documents. Redis is NEVER the source of
 * truth (PLAN Decision Log): this only accelerates the join/cold-start path so we
 * don't replay the whole op log from Postgres on every reconnect. Loads always
 * replay ops after the cached watermark, so a stale (or missing) cache entry is a
 * performance issue, never a correctness one — hence a TTL is safe.
 */

import { type DocumentSnapshot } from "@sync-flow/crdt";

/**
 * Narrow structural subset of the redis client used by this module. Kept separate
 * from `CacheClient` (which is only ping/quit for healthchecks) so existing fakes
 * don't break; the real redis client satisfies both.
 */
export interface CrdtStateCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<number>;
}

export const STATE_CACHE_TTL_SECONDS = 60 * 60; // 1h; refreshed on every load/snapshot.

interface CachedState {
  readonly seq: number;
  readonly state: DocumentSnapshot;
}

function stateKey(documentId: string): string {
  return `crdt:state:${documentId}`;
}

export async function readCachedState(
  cache: CrdtStateCache,
  documentId: string,
): Promise<CachedState | null> {
  const raw = await cache.get(stateKey(documentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedState;
  } catch {
    // A corrupt/legacy cache entry must never wedge a load — drop to the Postgres path.
    return null;
  }
}

export async function writeCachedState(
  cache: CrdtStateCache,
  documentId: string,
  seq: number,
  state: DocumentSnapshot,
): Promise<void> {
  const payload: CachedState = { seq, state };
  await cache.set(stateKey(documentId), JSON.stringify(payload), { EX: STATE_CACHE_TTL_SECONDS });
}

export async function invalidateCachedState(
  cache: CrdtStateCache,
  documentId: string,
): Promise<void> {
  await cache.del(stateKey(documentId));
}
