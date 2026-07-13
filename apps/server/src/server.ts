import { createServer } from "node:http";
import { loadConfig } from "@/config/env.js";
import { createLogger } from "@/logger/index.js";
import { createPgPool } from "@/db/pool.js";
import { createRedisClient } from "@/cache/client.js";
import { createApp } from "@/app.js";
import { createSocketServer } from "@/sockets/io.js";

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
  });

  const httpServer = createServer(app);
  const io = createSocketServer(httpServer, config.CORS_ORIGIN);

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
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
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
