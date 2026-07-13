import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

// Single-instance in-memory limiting for now. CLAUDE.md earmarks Redis for "optional
// rate-limiting" — swap in a Redis store here if/when the server runs multi-instance, since
// MemoryStore doesn't share state across processes.
export function createRateLimiter(config: RateLimitConfig): RequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(AppError.tooManyRequests("Rate limit exceeded, try again later."));
    },
  });
}
