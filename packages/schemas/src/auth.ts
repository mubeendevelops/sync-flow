import { z } from "zod";

const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a digit")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a symbol");

export const signupBodySchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(32, "Username must be at most 32 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Username may only contain letters, digits, underscore, and hyphen"),
  email: z.email(),
  password: passwordSchema,
  displayName: z.string().min(1, "Display name is required").max(100),
});
export type SignupBody = z.infer<typeof signupBodySchema>;

export const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Password is required"),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/** Matches apps/server's toPublicUser() — password_hash never leaves the server. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  email: z.email(),
  displayName: z.string(),
  presenceColor: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/** Response shape of /signup, /login, /refresh, and /me. */
export const authResponseSchema = z.object({
  user: publicUserSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;
