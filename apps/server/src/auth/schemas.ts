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

export const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Password is required"),
});
