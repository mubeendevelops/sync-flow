import { z } from "zod";
import { publicUserSchema } from "./auth.js";

export const userSearchQuerySchema = z.object({
  q: z.string().min(1).max(100),
});
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;

export const userSearchResponseSchema = z.object({
  users: z.array(publicUserSchema),
});
export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>;
