import arcjet, { detectBot, protectSignup, shield, slidingWindow } from "@arcjet/node";
import { env } from "../env.js";

// Note: rules configured with a non-default `characteristics` (e.g. tracking
// by a request body field like `email` instead of `ip.src`) currently fail
// fingerprint generation in @arcjet/node 1.9.1 ("... characteristic but the
// value was empty", reproduced with the value present and correctly wired
// through). Every rule below intentionally sticks to the default `ip.src`
// characteristic until that's fixed upstream.

/**
 * Signup form protection: bot blocking, email validation (rejects
 * disposable/invalid/undeliverable addresses), and a sliding-window rate
 * limit, all fingerprinted by source IP.
 */
export const signupArcjet = arcjet({
  key: env.ARCJET_KEY,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    protectSignup({
      email: {
        mode: "LIVE",
        deny: ["DISPOSABLE", "INVALID", "NO_MX_RECORDS"],
      },
      bots: {
        mode: "LIVE",
        allow: [],
      },
      rateLimit: {
        mode: "LIVE",
        interval: "10m",
        max: 5,
      },
    }),
  ],
});

/**
 * Login protection: shield + bot blocking + a per-IP sliding-window rate
 * limit. Credential stuffing against a single account spread across many
 * IPs isn't caught by this alone — Supabase's own auth rate limits and
 * failed-login lockouts are the backstop for that; see backend/README for
 * the tracked follow-up to add a per-account limiter once the upstream
 * Arcjet issue is fixed.
 */
export const loginArcjet = arcjet({
  key: env.ARCJET_KEY,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    detectBot({ mode: "LIVE", allow: [] }),
    slidingWindow({ mode: "LIVE", interval: "10m", max: 15 }),
  ],
});

/** Shield-only protection for authenticated, low-abuse-risk routes. */
export const baselineArcjet = arcjet({
  key: env.ARCJET_KEY,
  characteristics: ["ip.src"],
  rules: [shield({ mode: "LIVE" }), slidingWindow({ mode: "LIVE", interval: "1m", max: 30 })],
});
