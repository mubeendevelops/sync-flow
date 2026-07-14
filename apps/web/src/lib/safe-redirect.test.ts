import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it("accepts a plain path", () => {
    expect(safeRedirectPath("/documents/abc-123")).toBe("/documents/abc-123");
  });

  it("rejects null/undefined/empty", () => {
    expect(safeRedirectPath(null)).toBeNull();
    expect(safeRedirectPath(undefined)).toBeNull();
    expect(safeRedirectPath("")).toBeNull();
  });

  it("rejects a path that doesn't start with /", () => {
    expect(safeRedirectPath("documents")).toBeNull();
    expect(safeRedirectPath("https://evil.example/phish")).toBeNull();
  });

  it("rejects protocol-relative redirects", () => {
    expect(safeRedirectPath("//evil.example")).toBeNull();
    expect(safeRedirectPath("/\\evil.example")).toBeNull();
  });
});
