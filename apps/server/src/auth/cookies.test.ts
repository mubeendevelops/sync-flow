import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { setAuthCookies, clearAuthCookies, REFRESH_TOKEN_COOKIE } from "./cookies.js";

function fakeResponse() {
  const calls: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const res = {
    cookie: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
      calls.push({ name, value, options });
    }),
    clearCookie: vi.fn((name: string, options: Record<string, unknown>) => {
      calls.push({ name, value: "", options });
    }),
  };
  return { res: res as unknown as Response, calls };
}

const tokens = { accessToken: "a", refreshToken: "r", csrfToken: "c" };
const baseConfig = { domain: "api.example.com", accessTtlSeconds: 900, refreshTtlSeconds: 604800 };

describe("setAuthCookies", () => {
  it("defaults to Secure + SameSite=None (required for the cross-origin Vercel<->Railway split)", () => {
    const { res, calls } = fakeResponse();
    setAuthCookies(res, tokens, baseConfig);
    for (const call of calls) {
      expect(call.options.secure).toBe(true);
      expect(call.options.sameSite).toBe("none");
    }
  });

  it("falls back to SameSite=Lax when secure is explicitly disabled (test-only escape hatch)", () => {
    const { res, calls } = fakeResponse();
    setAuthCookies(res, tokens, { ...baseConfig, secure: false });
    for (const call of calls) {
      expect(call.options.secure).toBe(false);
      expect(call.options.sameSite).toBe("lax");
    }
  });

  it("scopes the refresh token cookie to the auth path only", () => {
    const { res, calls } = fakeResponse();
    setAuthCookies(res, tokens, baseConfig);
    const refreshCall = calls.find((c) => c.name === REFRESH_TOKEN_COOKIE)!;
    expect(refreshCall.options.path).toBe("/api/v1/auth");
  });

  it("marks access/refresh cookies httpOnly but the csrf cookie readable by JS", () => {
    const { res, calls } = fakeResponse();
    setAuthCookies(res, tokens, baseConfig);
    expect(calls.find((c) => c.name === "access_token")!.options.httpOnly).toBe(true);
    expect(calls.find((c) => c.name === "refresh_token")!.options.httpOnly).toBe(true);
    expect(calls.find((c) => c.name === "csrf_token")!.options.httpOnly).toBe(false);
  });
});

describe("clearAuthCookies", () => {
  it("clears all three cookies with matching domain/path", () => {
    const { res, calls } = fakeResponse();
    clearAuthCookies(res, { domain: "api.example.com" });
    expect(calls.map((c) => c.name).sort()).toEqual([
      "access_token",
      "csrf_token",
      "refresh_token",
    ]);
    expect(calls.find((c) => c.name === REFRESH_TOKEN_COOKIE)!.options.path).toBe("/api/v1/auth");
  });
});
