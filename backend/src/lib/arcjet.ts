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

/**
 * Forgot-password protection: shield + a per-IP sliding-window rate limit.
 * No protectSignup/email-validation rule here — unlike signup, telling a
 * caller "that address looks disposable/invalid" on this endpoint would
 * itself be an enumeration-adjacent signal, so it's intentionally left out.
 */
export const forgotPasswordArcjet = arcjet({
  key: env.ARCJET_KEY,
  characteristics: ["ip.src"],
  rules: [shield({ mode: "LIVE" }), slidingWindow({ mode: "LIVE", interval: "10m", max: 5 })],
});

/**
 * SSO authorize protection: shield + a per-IP sliding-window rate limit,
 * deliberately without detectBot. Unlike the password login form (a fetch()
 * POST with an Origin header and standard XHR fingerprint), this route is
 * hit via a top-level `window.location` navigation — a fundamentally
 * different header shape (Sec-Fetch-Mode: navigate, no Origin, no
 * X-Requested-With) that loginArcjet's bot rule was never tuned for and
 * produced false positives against, blocking real browser clicks.
 */
export const ssoArcjet = arcjet({
  key: env.ARCJET_KEY,
  characteristics: ["ip.src"],
  rules: [shield({ mode: "LIVE" }), slidingWindow({ mode: "LIVE", interval: "10m", max: 15 })],
});

/**
 * Shield-only protection for authenticated, low-abuse-risk routes. Keyed by
 * ip.src, so this one bucket is shared across every /api/projects/* route
 * (including all its nested resources) AND /api/invites/* — and across
 * every concurrently logged-in account on the same network, since they all
 * share one public IP. A SPA page load alone fires several parallel calls
 * (sidebar, page content, overview KPIs, the invite notification bell,
 * etc.), so 30/min was too tight for real multi-tab/multi-account usage,
 * not just abuse.
 */
export const baselineArcjet = arcjet({
  key: env.ARCJET_KEY,
  characteristics: ["ip.src"],
  rules: [shield({ mode: "LIVE" }), slidingWindow({ mode: "LIVE", interval: "1m", max: 120 })],
});
