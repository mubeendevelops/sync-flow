import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

/**
 * Bare Socket.io server — no auth/room handlers yet (that's the join-auth middleware
 * and doc-room work in later phases). Exists now so bootstrap/shutdown has a real
 * WS server to drain.
 */
export function createSocketServer(httpServer: HttpServer, corsOrigin: string): SocketIOServer {
  return new SocketIOServer(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });
}
