import argon2 from "argon2";

// A hash for a password nobody will ever type, run through argon2.verify() when no matching
// user exists — keeps failed-login latency identical whether the email exists or not.
const DUMMY_HASH = await argon2.hash("dummy-password-for-timing-safety", { type: argon2.argon2id });

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  return argon2.verify(hash ?? DUMMY_HASH, password);
}
