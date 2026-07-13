import { describe, expect, it } from "vitest";
import {
  parseTtlToSeconds,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateCsrfToken,
} from "./tokens.js";

describe("parseTtlToSeconds", () => {
  it.each([
    ["30s", 30],
    ["15m", 900],
    ["1h", 3600],
    ["7d", 604800],
  ])("parses %s as %d seconds", (input, expected) => {
    expect(parseTtlToSeconds(input)).toBe(expected);
  });

  it("rejects an unrecognized format", () => {
    expect(() => parseTtlToSeconds("15")).toThrow();
    expect(() => parseTtlToSeconds("15 minutes")).toThrow();
    expect(() => parseTtlToSeconds("")).toThrow();
  });
});

describe("access tokens", () => {
  const secret = "test-secret-0123456789";

  it("round-trips the user id through sign + verify", () => {
    const token = signAccessToken("user-123", secret, 900);
    const payload = verifyAccessToken(token, secret);
    expect(payload.sub).toBe("user-123");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAccessToken("user-123", secret, 900);
    expect(() => verifyAccessToken(token, "wrong-secret-0123456789")).toThrow();
  });

  it("rejects an expired token", () => {
    const token = signAccessToken("user-123", secret, -1);
    expect(() => verifyAccessToken(token, secret)).toThrow();
  });

  it("rejects a malformed token", () => {
    expect(() => verifyAccessToken("not-a-jwt", secret)).toThrow();
  });
});

describe("refresh tokens", () => {
  it("generates unique, sufficiently long opaque tokens", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("hashes deterministically for the same token+secret", () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token, "secret-a")).toBe(hashRefreshToken(token, "secret-a"));
  });

  it("produces different hashes for different secrets", () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token, "secret-a")).not.toBe(hashRefreshToken(token, "secret-b"));
  });

  it("produces different hashes for different tokens", () => {
    const [a, b] = [generateRefreshToken(), generateRefreshToken()];
    expect(hashRefreshToken(a, "secret")).not.toBe(hashRefreshToken(b, "secret"));
  });
});

describe("generateCsrfToken", () => {
  it("generates unique tokens", () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });
});
