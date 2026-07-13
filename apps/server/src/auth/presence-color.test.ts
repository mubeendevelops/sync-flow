import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { assignPresenceColor } from "./presence-color.js";

describe("assignPresenceColor", () => {
  it("is deterministic for the same user id", () => {
    const id = crypto.randomUUID();
    expect(assignPresenceColor(id)).toBe(assignPresenceColor(id));
  });

  it("returns a hex color", () => {
    expect(assignPresenceColor(crypto.randomUUID())).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("distributes across more than one palette entry over many ids", () => {
    const colors = new Set(
      Array.from({ length: 50 }, () => assignPresenceColor(crypto.randomUUID())),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
