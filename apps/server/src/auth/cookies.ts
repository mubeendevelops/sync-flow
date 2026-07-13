import type { CookieOptions, Response } from "express";

export const ACCESS_TOKEN_COOKIE = "access_token";
export const REFRESH_TOKEN_COOKIE = "refresh_token";
export const CSRF_TOKEN_COOKIE = "csrf_token";

const REFRESH_COOKIE_PATH = "/api/v1/auth";

export interface CookieConfig {
  domain: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /**
   * Defaults to true. `apps/web` (Vercel) and `apps/server` (Railway) are different origins in
   * production, so these cookies are inherently cross-site: SameSite=None is required for the
   * browser to attach them to cross-origin requests at all, and Secure is required alongside
   * None (browsers reject SameSite=None without it). Real browsers special-case "localhost" as
   * trustworthy, so this holds for local dev too — the one exception is plain Node HTTP clients
   * (e.g. supertest in integration tests), which enforce Secure literally and drop the cookie
   * over http://, so tests pass `secure: false` here.
   */
  secure?: boolean;
}

// SameSite=None forfeits SameSite's built-in CSRF protection, which is why `csrfProtection`
// (double-submit against CSRF_TOKEN_COOKIE) exists on every cookie-authenticated state-changing
// route.
function baseCookieOptions(config: Pick<CookieConfig, "domain" | "secure">): CookieOptions {
  const secure = config.secure ?? true;
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    domain: config.domain,
    path: "/",
  };
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

export function setAuthCookies(res: Response, tokens: SessionTokens, config: CookieConfig): void {
  const base = baseCookieOptions(config);
  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...base,
    maxAge: config.accessTtlSeconds * 1000,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: config.refreshTtlSeconds * 1000,
  });
  // Not httpOnly by design: the double-submit CSRF pattern requires client JS to read this
  // cookie and echo it back in a request header.
  res.cookie(CSRF_TOKEN_COOKIE, tokens.csrfToken, {
    ...base,
    httpOnly: false,
    maxAge: config.refreshTtlSeconds * 1000,
  });
}

export function clearAuthCookies(
  res: Response,
  config: Pick<CookieConfig, "domain" | "secure">,
): void {
  const base = baseCookieOptions(config);
  res.clearCookie(ACCESS_TOKEN_COOKIE, base);
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_TOKEN_COOKIE, { ...base, httpOnly: false });
}
