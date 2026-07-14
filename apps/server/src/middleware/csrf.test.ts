import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { csrfProtection, CSRF_HEADER } from "./csrf.js";
import { CSRF_TOKEN_COOKIE } from "../auth/cookies.js";

function fakeReq(method: string, cookies: Record<string, unknown>, header?: string): Request {
  return {
    method,
    cookies,
    get: (name: string) => (name.toLowerCase() === CSRF_HEADER ? header : undefined),
  } as unknown as Request;
}

describe("csrfProtection", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "passes safe method %s through without checking tokens",
    (method) => {
      const next = vi.fn() as unknown as NextFunction;
      csrfProtection(fakeReq(method, {}), {} as Response, next);
      expect(next).toHaveBeenCalledWith();
    },
  );

  it("rejects a state-changing request with no CSRF cookie", () => {
    const next = vi.fn() as unknown as NextFunction;
    csrfProtection(fakeReq("POST", {}, "some-token"), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it("rejects a state-changing request with no CSRF header", () => {
    const next = vi.fn() as unknown as NextFunction;
    csrfProtection(fakeReq("POST", { [CSRF_TOKEN_COOKIE]: "tok" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it("rejects when the cookie and header tokens don't match", () => {
    const next = vi.fn() as unknown as NextFunction;
    csrfProtection(
      fakeReq("POST", { [CSRF_TOKEN_COOKIE]: "tok-a" }, "tok-b"),
      {} as Response,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it("passes when the cookie and header tokens match", () => {
    const next = vi.fn() as unknown as NextFunction;
    csrfProtection(
      fakeReq("POST", { [CSRF_TOKEN_COOKIE]: "tok-match" }, "tok-match"),
      {} as Response,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});
