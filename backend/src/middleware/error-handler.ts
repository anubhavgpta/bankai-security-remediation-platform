import type { NextFunction, Request, Response } from "express";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";

// Express only treats a handler as error-handling middleware if it has
// exactly 4 declared parameters, so `_next` must stay even though it's unused.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, "Request failed");
    }
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  logger.error({ err, path: req.path }, "Unhandled error");
  res.status(500).json({
    error: env.NODE_ENV === "production" ? "Something went wrong" : String(err instanceof Error ? err.stack : err),
  });
}
