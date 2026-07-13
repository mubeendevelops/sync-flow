import { createClient, type RedisClientType } from "redis";

/** The only place the `redis` client is constructed — everywhere else takes a `CacheClient`. */
export function createRedisClient(url: string): RedisClientType {
  return createClient({ url }) as RedisClientType;
}
