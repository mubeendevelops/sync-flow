import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string };
    }
  }
}

export interface RequireAuthDeps {
  jwtAccessSecret: string;
}

/** Verifies the access-token cookie and attaches `req.user`. Rejects with 401, never refreshes
 * — the client is expected to catch a 401, call POST /auth/refresh, and retry. */
export function requireAuth(deps: RequireAuthDeps): RequestHandler {
  return (req, _res, next) => {
    const token: unknown = req.cookies?.[ACCESS_TOKEN_COOKIE];
    if (typeof token !== "string") {
      next(AppError.unauthorized("Authentication required"));
      return;
    }
    try {
      const payload = verifyAccessToken(token, deps.jwtAccessSecret);
      req.user = { id: payload.sub };
      next();
    } catch {
      next(AppError.unauthorized("Invalid or expired access token"));
    }
  };
}
