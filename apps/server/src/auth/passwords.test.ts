import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("hashPassword / verifyPassword", () => {
  it("verifies a correct password against its own hash", async () => {
    const hash = await hashPassword("Correct-Horse-9");
    await expect(verifyPassword(hash, "Correct-Horse-9")).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("Correct-Horse-9");
    await expect(verifyPassword(hash, "Wrong-Password-1")).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const [a, b] = await Promise.all([
      hashPassword("Correct-Horse-9"),
      hashPassword("Correct-Horse-9"),
    ]);
    expect(a).not.toBe(b);
  });

  it("uses the argon2id variant", async () => {
    const hash = await hashPassword("Correct-Horse-9");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("returns false (never throws) when checked against a null hash", async () => {
    await expect(verifyPassword(null, "anything")).resolves.toBe(false);
  });
});
