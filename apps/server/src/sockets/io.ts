import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import type { createAdapter } from "@socket.io/redis-adapter";
import type { DbClient } from "../db/types.js";
import type { CrdtStateCache, DocumentStoreLogger } from "../crdt-service/index.js";
import { authenticateSocket } from "./authenticate.js";
import { DocumentRoomManager } from "./room-manager.js";
import { registerDocHandlers, type DocSocket } from "./handlers.js";
import { TokenBucket, type TokenBucketOptions } from "./rate-limit.js";
import type { PresenceCache } from "./presence.js";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "./types.js";

export interface SocketServerDeps {
  readonly corsOrigin: string;
  readonly jwtAccessSecret: string;
  readonly db: DbClient;
  /** The redis client (satisfies both the CRDT state cache and presence surfaces). */
  readonly cache: CrdtStateCache & PresenceCache;
  readonly logger?: DocumentStoreLogger;
  /** Redis pub/sub adapter for cross-instance fan-out; omit for a single-instance/in-memory setup. */
  readonly adapter?: ReturnType<typeof createAdapter>;
  readonly rate?: TokenBucketOptions;
  readonly syncThreshold?: number;
}

export type DocIOServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface SocketServer {
  readonly io: DocIOServer;
  /** The shared room/store registry — drain via `closeAll()` on graceful shutdown. */
  readonly manager: DocumentRoomManager;
}

/** Emit `auth:expired` when the access token behind this connection lapses mid-session. */
function scheduleAuthExpiry(socket: DocSocket): void {
  const exp = socket.data.tokenExp;
  if (typeof exp !== "number") return;
  const ms = exp * 1000 - Date.now();
  if (ms <= 0) {
    socket.emit("auth:expired");
    return;
  }
  const timer = setTimeout(() => socket.emit("auth:expired"), ms);
  socket.on("disconnect", () => clearTimeout(timer));
}

export function createSocketServer(httpServer: HttpServer, deps: SocketServerDeps): SocketServer {
  const io: DocIOServer = new SocketIOServer(httpServer, {
    cors: { origin: deps.corsOrigin, credentials: true },
  });

  if (deps.adapter) io.adapter(deps.adapter);

  // Same JWT verification as REST — verified on the HTTP upgrade before the socket connects.
  io.use(authenticateSocket({ jwtAccessSecret: deps.jwtAccessSecret }));

  const manager = new DocumentRoomManager({ db: deps.db, cache: deps.cache, logger: deps.logger });

  io.on("connection", (socket) => {
    socket.data.rate = new TokenBucket(deps.rate);
    scheduleAuthExpiry(socket);
    registerDocHandlers(socket, {
      db: deps.db,
      manager,
      presence: deps.cache,
      logger: deps.logger,
      syncThreshold: deps.syncThreshold,
    });
  });

  return { io, manager };
}
