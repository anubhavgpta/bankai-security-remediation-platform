import { isSpoofedBot } from "@arcjet/inspect";
import type { ArcjetDecision } from "@arcjet/protocol";
import { HttpError } from "./http-error.js";
import { logger } from "./logger.js";

/**
 * Translates an Arcjet decision into an HttpError, or does nothing if the
 * request is allowed. Messages are deliberately generic for bot/shield
 * denials (no need to tip off an attacker) but specific for rate limits and
 * email validation, which are useful for a legitimate user to see.
 */
export function assertArcjetAllowed(decision: ArcjetDecision): void {
  if (decision.isErrored()) {
    // Fail closed on unexpected SDK/API errors would take the whole auth
    // flow down with an Arcjet outage; log and allow the request through
    // instead, relying on the other defense layers (zod validation, Supabase
    // itself) to catch abuse.
    logger.error({ err: decision.reason }, "Arcjet decision errored");
    return;
  }

  if (!decision.isDenied()) {
    // A client claiming to be a well-known crawler (e.g. Googlebot) but
    // whose connection doesn't match that crawler's verified IP range —
    // allowed through by detectBot's allowlist on user-agent alone, but
    // still worth blocking here.
    if (decision.results.some(isSpoofedBot)) {
      throw new HttpError(403, "Request blocked.");
    }
    return;
  }

  if (decision.reason.isRateLimit()) {
    throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
  }

  if (decision.reason.isEmail()) {
    throw new HttpError(400, "That email address can't be used. Please use a different one.");
  }

  if (decision.reason.isBot()) {
    throw new HttpError(403, "Request blocked.");
  }

  throw new HttpError(403, "Request blocked.");
}
