/**
 * Redis pub/sub adapter for cross-instance fan-out (PLAN 2.7). With it installed,
 * `socket.to(docId).emit(...)` reaches that room's members on every server instance,
 * not just the one holding the emitting socket. A subscriber connection cannot issue
 * normal commands, so the adapter needs its own dedicated pub + sub connections,
 * duplicated from (and independent of) the app's cache client.
 */

import { createAdapter } from "@socket.io/redis-adapter";
import type { RedisClientType } from "redis";

export interface RedisAdapterLogger {
  error(obj: unknown, msg?: string): void;
}

export interface RedisAdapter {
  readonly adapter: ReturnType<typeof createAdapter>;
  readonly pub: RedisClientType;
  readonly sub: RedisClientType;
}

/**
 * Duplicate + connect a pub/sub pair from the base client and build the adapter.
 *
 * Each `duplicate()` is an independent socket with its own `error` EventEmitter — the base
 * client's `.on("error", ...)` in server.ts does NOT cover these. An unhandled `error` event
 * on ANY EventEmitter crashes the whole Node process (this is how a Redis outage previously
 * took the entire server down instead of degrading gracefully — see PLAN.md chaos findings).
 * The underlying `redis` client already retries connection with backoff by default, so simply
 * observing (not swallowing-and-ignoring) the event here is enough to let that recovery run
 * instead of crashing.
 */
export async function createRedisAdapter(
  base: RedisClientType,
  logger?: RedisAdapterLogger,
): Promise<RedisAdapter> {
  const pub = base.duplicate();
  const sub = base.duplicate();
  pub.on("error", (err: unknown) => logger?.error({ err }, "redis adapter pub connection error"));
  sub.on("error", (err: unknown) => logger?.error({ err }, "redis adapter sub connection error"));
  await Promise.all([pub.connect(), sub.connect()]);
  return { adapter: createAdapter(pub, sub), pub, sub };
}
