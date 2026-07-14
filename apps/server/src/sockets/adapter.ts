/**
 * Redis pub/sub adapter for cross-instance fan-out (PLAN 2.7). With it installed,
 * `socket.to(docId).emit(...)` reaches that room's members on every server instance,
 * not just the one holding the emitting socket. A subscriber connection cannot issue
 * normal commands, so the adapter needs its own dedicated pub + sub connections,
 * duplicated from (and independent of) the app's cache client.
 */

import { createAdapter } from "@socket.io/redis-adapter";
import type { RedisClientType } from "redis";

export interface RedisAdapter {
  readonly adapter: ReturnType<typeof createAdapter>;
  readonly pub: RedisClientType;
  readonly sub: RedisClientType;
}

/** Duplicate + connect a pub/sub pair from the base client and build the adapter. */
export async function createRedisAdapter(base: RedisClientType): Promise<RedisAdapter> {
  const pub = base.duplicate();
  const sub = base.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  return { adapter: createAdapter(pub, sub), pub, sub };
}
