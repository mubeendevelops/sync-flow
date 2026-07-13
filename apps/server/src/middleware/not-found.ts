import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
};
