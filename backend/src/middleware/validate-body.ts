import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { HttpError } from "../lib/http-error.js";

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      next(new HttpError(422, "Invalid request data", fieldErrors));
      return;
    }
    req.body = result.data;
    next();
  };
}
