import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "./require-auth.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";

const SECRET = "test-secret-at-least-16-chars";

function fakeReq(cookies: Record<string, unknown> = {}): Request {
  return { cookies } as unknown as Request;
}

describe("requireAuth", () => {
  const middleware = requireAuth({ jwtAccessSecret: SECRET });

  it("rejects when no access-token cookie is present", () => {
    const next = vi.fn() as unknown as NextFunction;
    middleware(fakeReq(), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("rejects when the cookie value is not a string", () => {
    const next = vi.fn() as unknown as NextFunction;
    middleware(fakeReq({ [ACCESS_TOKEN_COOKIE]: 12345 }), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("rejects an invalid/expired token", () => {
    const next = vi.fn() as unknown as NextFunction;
    middleware(fakeReq({ [ACCESS_TOKEN_COOKIE]: "not-a-real-jwt" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, detail: "Invalid or expired access token" }),
    );
  });

  it("attaches req.user and calls next() with no error for a valid token", () => {
    const token = signAccessToken("user-123", SECRET, 900);
    const req = fakeReq({ [ACCESS_TOKEN_COOKIE]: token });
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, {} as Response, next);
    expect(req.user).toEqual({ id: "user-123" });
    expect(next).toHaveBeenCalledWith();
  });
});
