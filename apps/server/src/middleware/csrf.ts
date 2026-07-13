import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { CSRF_TOKEN_COOKIE } from "../auth/cookies.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const CSRF_HEADER = "x-csrf-token";

/**
 * Double-submit CSRF check. Cookies here are SameSite=None (required for the cross-origin
 * Vercel<->Railway split — see cookies.ts), which forfeits SameSite's own CSRF protection. This
 * restores it: an attacker's page can trigger a cross-site request carrying the ambient cookie,
 * but same-origin policy stops it from ever reading CSRF_TOKEN_COOKIE to echo it in the header.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookieToken: unknown = req.cookies?.[CSRF_TOKEN_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (typeof cookieToken !== "string" || !headerToken || cookieToken !== headerToken) {
    next(AppError.forbidden("Missing or invalid CSRF token"));
    return;
  }
  next();
};
