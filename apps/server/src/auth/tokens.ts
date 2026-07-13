import crypto from "node:crypto";
import jwt from "jsonwebtoken";

export interface AccessTokenPayload {
  sub: string;
}

/** "15m", "7d", "1h", "30s" -> seconds. The only TTL format the app accepts (matches .env.example). */
export function parseTtlToSeconds(ttl: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(ttl);
  if (!match) {
    throw new Error(`Invalid TTL format: "${ttl}" (expected e.g. "15m", "7d")`);
  }
  const value = Number(match[1]);
  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
  return value * unitSeconds;
}

export function signAccessToken(userId: string, secret: string, ttlSeconds: number): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: ttlSeconds });
}

/**
 * Verifies an access token JWT. This is the single verification implementation shared by the
 * `requireAuth` Express middleware and the `authenticateSocket` Socket.io middleware — one
 * source of truth for what makes an access token valid.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenPayload {
  const payload = jwt.verify(token, secret);
  if (typeof payload === "string" || typeof payload.sub !== "string") {
    throw new Error("Invalid access token payload");
  }
  return { sub: payload.sub };
}

/** Opaque random refresh token — DB-backed (see refresh_tokens table), not a JWT. */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Keyed hash for at-rest storage: a leaked DB row alone can't be replayed without the secret. */
export function hashRefreshToken(token: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function generateCsrfToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
