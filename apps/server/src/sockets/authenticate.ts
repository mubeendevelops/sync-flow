import { parseCookie } from "cookie";
import type { Socket } from "socket.io";
import { verifyAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";

export interface AuthenticateSocketDeps {
  jwtAccessSecret: string;
}

/**
 * Socket.io middleware (`io.use(authenticateSocket(deps))`) — reads the access-token cookie off
 * the HTTP upgrade request and verifies it with the exact same `verifyAccessToken` the
 * `requireAuth` Express middleware uses, so HTTP and WS auth can never drift apart. Not wired
 * into `createSocketServer` yet — that lands with the doc-room work; this just makes the
 * verification available to it.
 */
export function authenticateSocket(deps: AuthenticateSocketDeps) {
  return (socket: Socket, next: (err?: Error) => void): void => {
    const cookieHeader = socket.handshake.headers.cookie;
    const token = cookieHeader ? parseCookie(cookieHeader)[ACCESS_TOKEN_COOKIE] : undefined;
    if (!token) {
      next(new Error("Authentication required"));
      return;
    }
    try {
      const payload = verifyAccessToken(token, deps.jwtAccessSecret);
      socket.data.user = { id: payload.sub };
      next();
    } catch {
      next(new Error("Invalid or expired access token"));
    }
  };
}
