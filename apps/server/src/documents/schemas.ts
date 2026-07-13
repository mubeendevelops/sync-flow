import { z } from "zod";

export const documentIdParamsSchema = z.object({ id: z.uuid() });

export const memberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() });

export const listDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createDocumentBodySchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be at most 200 characters"),
});

export const patchDocumentBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((data) => data.title !== undefined || data.isPublic !== undefined, {
    message: "At least one of title or isPublic must be provided",
  });

export const inviteBodySchema = z.object({
  email: z.email(),
  role: z.enum(["editor", "viewer"]),
});

export const listOperationsQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
