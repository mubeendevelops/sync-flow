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

      if (key === "query") {
        // Express 5's req.query is a getter that re-parses the raw query string from scratch on
        // every access and has no setter, so Object.assign onto it is silently discarded and
        // any coercion/defaults from the schema never actually reach the handler. Overriding the
        // property itself (still configurable) makes the parsed value stick for this request.
        Object.defineProperty(req, "query", {
          value: result.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        Object.assign(req[key], result.data);
      }
    }
    next();
  };
}
