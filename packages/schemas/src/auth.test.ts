import { describe, expect, it } from "vitest";
import { loginBodySchema, publicUserSchema, signupBodySchema } from "./auth.js";

describe("signupBodySchema", () => {
  it("accepts a valid signup payload", () => {
    const result = signupBodySchema.safeParse({
      username: "ada_lovelace",
      email: "ada@example.com",
      password: "Str0ng!Passw0rd",
      displayName: "Ada Lovelace",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a password missing a symbol", () => {
    const result = signupBodySchema.safeParse({
      username: "ada",
      email: "ada@example.com",
      password: "StrongPassw0rd",
      displayName: "Ada",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a username with invalid characters", () => {
    const result = signupBodySchema.safeParse({
      username: "ada lovelace!",
      email: "ada@example.com",
      password: "Str0ng!Passw0rd",
      displayName: "Ada",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginBodySchema", () => {
  it("rejects a malformed email", () => {
    const result = loginBodySchema.safeParse({ email: "not-an-email", password: "x" });
    expect(result.success).toBe(false);
  });
});

describe("publicUserSchema", () => {
  it("never expects a password field — mirrors toPublicUser()", () => {
    expect(Object.keys(publicUserSchema.shape)).not.toContain("password");
    expect(Object.keys(publicUserSchema.shape)).not.toContain("passwordHash");
  });
});
