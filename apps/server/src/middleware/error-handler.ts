import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors/app-error.js";

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  [extension: string]: unknown;
}

/**
 * Renders every error as RFC 7807 application/problem+json. Never forwards a raw
 * message/stack for non-AppErrors in production — only the generic title survives.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isAppError = err instanceof AppError;
  const isProduction = process.env.NODE_ENV === "production";

  const status = isAppError ? err.status : 500;
  const title = isAppError ? err.title : "Internal Server Error";
  const detail = isAppError
    ? err.detail
    : !isProduction && err instanceof Error
      ? err.message
      : undefined;

  const problem: ProblemDetails = {
    type: isAppError ? err.type : "about:blank",
    title,
    status,
    detail,
    instance: req.originalUrl,
    ...(isAppError ? err.extensions : undefined),
  };

  if (status >= 500) {
    req.log.error({ err }, "unhandled error");
  } else {
    req.log.warn({ err: err instanceof Error ? err.message : err }, "request error");
  }

  res.status(status).type("application/problem+json").json(problem);
};
