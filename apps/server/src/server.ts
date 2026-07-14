import { createServer } from "node:http";
import { loadConfig } from "@/config/env.js";
import { createLogger } from "@/logger/index.js";
import { createPgPool } from "@/db/pool.js";
import { createRedisClient } from "@/cache/client.js";
import { createApp } from "@/app.js";
import { createSocketServer } from "@/sockets/io.js";
import { createRedisAdapter } from "@/sockets/adapter.js";
import { createPeerOpRelay } from "@/sockets/peer-relay.js";
import { DocumentRoomManager } from "@/sockets/room-manager.js";
import { parseTtlToSeconds } from "@/auth/tokens.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV, config.LOG_LEVEL);

  const pool = createPgPool(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL);
  redis.on("error", (err) => logger.error({ err }, "redis client error"));
  await redis.connect();

  const app = createApp({
    logger,
    db: pool,
    cache: redis,
    corsOrigin: config.CORS_ORIGIN,
    auth: {
      jwtAccessSecret: config.JWT_ACCESS_SECRET,
      jwtRefreshSecret: config.JWT_REFRESH_SECRET,
      jwtAccessTtlSeconds: parseTtlToSeconds(config.JWT_ACCESS_TTL),
      jwtRefreshTtlSeconds: parseTtlToSeconds(config.JWT_REFRESH_TTL),
      cookieDomain: config.COOKIE_DOMAIN,
    },
  });

  const httpServer = createServer(app);
  const { adapter, pub, sub } = await createRedisAdapter(redis);
  // Built up-front (rather than left to createSocketServer's internal default) so the
  // peer-apply relay below can be wired to the same manager before any connection lands.
  const manager = new DocumentRoomManager({ db: pool, cache: redis, logger });
  const peerRelay = await createPeerOpRelay(redis, manager, logger);
  const { io } = createSocketServer(httpServer, {
    corsOrigin: config.CORS_ORIGIN,
    jwtAccessSecret: config.JWT_ACCESS_SECRET,
    db: pool,
    cache: redis,
    logger,
    adapter,
    manager,
    peerRelay,
  });

  httpServer.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "server listening");
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    try {
      // Order matters: stop accepting new WS connections before closing pg/redis,
      // so in-flight requests still have a working pool/cache to finish against.
      await new Promise<void>((resolve, reject) => {
        io.close((err) => (err ? reject(err) : resolve()));
      });
      // Drain open doc stores (flush buffered ops + final snapshots) before pg closes.
      await manager.closeAll();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
      await peerRelay.close();
      await Promise.all([pub.quit(), sub.quit()]);
      await redis.quit();

      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
