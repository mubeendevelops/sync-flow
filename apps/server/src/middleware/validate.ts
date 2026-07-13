import type { RequestHandler } from "express";
import { z, type ZodType } from "zod";
import { AppError } from "../errors/app-error.js";

interface ValidationSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

/** Parses+replaces req.params/query/body against the given zod schemas, in that order. */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    for (const key of ["params", "query", "body"] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        next(
          AppError.badRequest(`Request ${key} failed validation`, {
            errors: z.treeifyError(result.error),
          }),
        );
        return;
      }

      Object.assign(req[key], result.data);
    }
    next();
  };
}
