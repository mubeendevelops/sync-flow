import crypto from "node:crypto";
import { Router, type Response } from "express";
import type { DbClient } from "../db/types.js";
import { AppError } from "../errors/app-error.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/require-auth.js";
import { csrfProtection } from "../middleware/csrf.js";
import { createRateLimiter, type RateLimitConfig } from "../middleware/rate-limit.js";
import { signupBodySchema, loginBodySchema } from "../auth/schemas.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { assignPresenceColor } from "../auth/presence-color.js";
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateCsrfToken,
} from "../auth/tokens.js";
import { setAuthCookies, clearAuthCookies, REFRESH_TOKEN_COOKIE } from "../auth/cookies.js";
import {
  findUserByEmailOrUsername,
  findUserByEmail,
  findUserById,
  insertUser,
  toPublicUser,
  type UserRecord,
} from "../auth/users.repo.js";
import {
  insertRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
} from "../auth/refresh-tokens.repo.js";

export interface AuthRouterDeps {
  db: DbClient;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  cookieDomain: string;
  /** See CookieConfig.secure — defaults to true; only tests should pass false. */
  secureCookies?: boolean;
  /** Applied to /signup and /login. Defaults to 20 requests / 15 minutes per IP. */
  authRateLimit?: RateLimitConfig;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = { windowMs: 15 * 60 * 1000, max: 20 };

const PG_UNIQUE_VIOLATION = "23505";

async function issueSession(
  res: Response,
  user: UserRecord,
  deps: AuthRouterDeps,
  familyId: string = crypto.randomUUID(),
): Promise<void> {
  const accessToken = signAccessToken(user.id, deps.jwtAccessSecret, deps.jwtAccessTtlSeconds);
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken, deps.jwtRefreshSecret);
  const csrfToken = generateCsrfToken();
  const expiresAt = new Date(Date.now() + deps.jwtRefreshTtlSeconds * 1000);

  await insertRefreshToken(deps.db, { userId: user.id, familyId, tokenHash, expiresAt });

  setAuthCookies(
    res,
    { accessToken, refreshToken, csrfToken },
    {
      domain: deps.cookieDomain,
      accessTtlSeconds: deps.jwtAccessTtlSeconds,
      refreshTtlSeconds: deps.jwtRefreshTtlSeconds,
      secure: deps.secureCookies,
    },
  );
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const authRateLimiter = createRateLimiter(deps.authRateLimit ?? DEFAULT_RATE_LIMIT);

  router.post(
    "/signup",
    authRateLimiter,
    validate({ body: signupBodySchema }),
    async (req, res, next) => {
      try {
        const { username, email, password, displayName } = req.body as {
          username: string;
          email: string;
          password: string;
          displayName: string;
        };

        const existing = await findUserByEmailOrUsername(deps.db, email, username);
        if (existing.some((u) => u.email === email)) {
          next(AppError.conflict("Email already in use"));
          return;
        }
        if (existing.some((u) => u.username === username)) {
          next(AppError.conflict("Username already in use"));
          return;
        }

        const passwordHash = await hashPassword(password);
        const id = crypto.randomUUID();
        const presenceColor = assignPresenceColor(id);

        let user: UserRecord;
        try {
          user = await insertUser(deps.db, {
            id,
            username,
            email,
            passwordHash,
            displayName,
            presenceColor,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            next(AppError.conflict("Email or username already in use"));
            return;
          }
          throw err;
        }

        await issueSession(res, user, deps);
        res.status(201).json({ user: toPublicUser(user) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/login",
    authRateLimiter,
    validate({ body: loginBodySchema }),
    async (req, res, next) => {
      try {
        const { email, password } = req.body as { email: string; password: string };

        const user = await findUserByEmail(deps.db, email);
        // Always run verifyPassword, even with no matching user, so response timing doesn't
        // reveal whether the email exists (verifyPassword falls back to a dummy hash internally).
        const valid = await verifyPassword(user?.password_hash ?? null, password);

        if (!user || !user.password_hash || !valid) {
          next(AppError.unauthorized("Invalid email or password"));
          return;
        }

        await issueSession(res, user, deps);
        res.status(200).json({ user: toPublicUser(user) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/refresh", csrfProtection, async (req, res, next) => {
    try {
      const rawToken: unknown = req.cookies?.[REFRESH_TOKEN_COOKIE];
      if (typeof rawToken !== "string") {
        next(AppError.unauthorized("Refresh token required"));
        return;
      }

      const tokenHash = hashRefreshToken(rawToken, deps.jwtRefreshSecret);
      const record = await findRefreshTokenByHash(deps.db, tokenHash);

      if (!record) {
        next(AppError.unauthorized("Invalid refresh token"));
        return;
      }
      if (record.revoked_at) {
        // Reuse of an already-rotated token: the family is compromised, kill every session in it.
        await revokeRefreshTokenFamily(deps.db, record.family_id);
        clearAuthCookies(res, { domain: deps.cookieDomain, secure: deps.secureCookies });
        next(AppError.unauthorized("Refresh token reuse detected; all sessions revoked"));
        return;
      }
      if (record.expires_at.getTime() < Date.now()) {
        next(AppError.unauthorized("Refresh token expired"));
        return;
      }

      const user = await findUserById(deps.db, record.user_id);
      if (!user) {
        next(AppError.unauthorized("Invalid refresh token"));
        return;
      }

      await revokeRefreshToken(deps.db, record.id);
      await issueSession(res, user, deps, record.family_id);
      res.status(200).json({ user: toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/me",
    requireAuth({ jwtAccessSecret: deps.jwtAccessSecret }),
    async (req, res, next) => {
      try {
        const user = await findUserById(deps.db, req.user!.id);
        if (!user) {
          next(AppError.unauthorized("User no longer exists"));
          return;
        }
        res.status(200).json({ user: toPublicUser(user) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/logout",
    requireAuth({ jwtAccessSecret: deps.jwtAccessSecret }),
    csrfProtection,
    async (req, res, next) => {
      try {
        const rawToken: unknown = req.cookies?.[REFRESH_TOKEN_COOKIE];
        if (typeof rawToken === "string") {
          const tokenHash = hashRefreshToken(rawToken, deps.jwtRefreshSecret);
          const record = await findRefreshTokenByHash(deps.db, tokenHash);
          if (record) {
            await revokeRefreshToken(deps.db, record.id);
          }
        }
        clearAuthCookies(res, { domain: deps.cookieDomain, secure: deps.secureCookies });
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && err.code === PG_UNIQUE_VIOLATION
  );
}
