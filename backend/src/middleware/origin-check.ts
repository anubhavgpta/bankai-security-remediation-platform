import type { NextFunction, Request, Response } from "express";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Defense-in-depth CSRF mitigation for the cookie-based session: browsers
 * attach an `Origin` header to every same-origin and cross-origin
 * POST/PUT/PATCH/DELETE fetch/XHR request, so a mismatch means the request
 * didn't originate from the app itself. Combined with `SameSite` cookies,
 * this closes the gap SameSite alone leaves on browsers/proxies that don't
 * enforce it consistently.
 */
export function originCheck(req: Request, _res: Response, next: NextFunction): void {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get("origin");
  if (!origin) {
    // Non-browser clients (curl, server-to-server) don't send Origin.
    // Nothing to check against, so let it through to the actual auth logic.
    next();
    return;
  }

  if (origin !== env.FRONTEND_ORIGIN) {
    next(new HttpError(403, "Request origin not allowed"));
    return;
  }

  next();
}
