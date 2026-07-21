import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getAuthenticatedGithubUser,
  listAuthenticatedUserRepos,
} from "../lib/github-oauth.js";
import { GithubApiError } from "../lib/github.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { createUserScopedSupabaseClient, supabaseAdmin } from "../lib/supabase.js";

const STATE_MAX_AGE_MS = 5 * 60 * 1000;

interface GithubOAuthState {
  nonce: string;
  userId: string;
  issuedAt: number;
}

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

function signStatePayload(payload: string): string {
  return createHmac("sha256", env.TOKEN_ENC_KEY).update(payload).digest("base64url");
}

function encodeState(state: GithubOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${payload}.${signStatePayload(payload)}`;
}

function decodeState(raw: string): GithubOAuthState | null {
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;

  const expected = signStatePayload(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<GithubOAuthState>;
    if (
      typeof parsed.nonce !== "string"
      || typeof parsed.userId !== "string"
      || typeof parsed.issuedAt !== "number"
      || Date.now() - parsed.issuedAt > STATE_MAX_AGE_MS
    ) {
      return null;
    }
    return { nonce: parsed.nonce, userId: parsed.userId, issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}

// Kicks off the OAuth redirect. Real navigation (the frontend sets
// window.location, not fetch), so this always ends in a redirect — never a
// JSON error — GitHub is the next hop.
export function authorizeGithubAccount(req: Request, res: Response): void {
  const state = encodeState({
    nonce: randomBytes(24).toString("hex"),
    userId: req.user!.id,
    issuedAt: Date.now(),
  });
  res.redirect(buildAuthorizeUrl(state));
}

// The callback is also a top-level browser navigation (GitHub redirecting
// back), so — same as authorize — every path here ends in a redirect to the
// frontend, never a raw JSON error response, which the browser would just
// render as a blank/ugly page.
export async function githubAccountCallback(req: Request, res: Response): Promise<void> {
  const redirectTo = (status: "connected" | "error") => res.redirect(`${env.FRONTEND_ORIGIN}/settings?github_account=${status}`);

  const { code, state, error: oauthError } = req.query;
  if (oauthError) {
    // User declined the authorization on GitHub's consent screen — not a
    // bug, nothing to log as an error.
    redirectTo("error");
    return;
  }
  if (typeof state !== "string" || typeof code !== "string") {
    logger.warn({ hasState: typeof state === "string", hasCode: typeof code === "string" }, "GitHub OAuth callback missing state or code");
    redirectTo("error");
    return;
  }

  const verifiedState = decodeState(state);
  if (!verifiedState) {
    logger.warn("GitHub OAuth callback failed state verification");
    redirectTo("error");
    return;
  }

  try {
    const { token, scope } = await exchangeCodeForToken(code);
    const identity = await getAuthenticatedGithubUser(token);

    const { error: dbError } = await supabaseAdmin
      .from("profiles")
      .update({
        github_user_id: identity.id,
        github_login: identity.login,
        github_user_token_enc: encrypt(token),
        github_oauth_scope: scope,
        github_oauth_connected_at: new Date().toISOString(),
      })
      .eq("id", verifiedState.userId);

    if (dbError) {
      logger.error({ err: dbError, userId: verifiedState.userId }, "Could not persist GitHub account connection");
      redirectTo("error");
      return;
    }

    redirectTo("connected");
  } catch (err) {
    logger.error({ err, userId: verifiedState.userId }, "GitHub OAuth callback failed");
    redirectTo("error");
  }
}

interface GithubIdentityRow {
  github_login: string | null;
  github_oauth_connected_at: string | null;
}

export async function getGithubAccountStatus(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("profiles")
    .select("github_login, github_oauth_connected_at")
    .eq("id", req.user!.id)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not load your GitHub account connection.");
  }

  const row = data as GithubIdentityRow;
  res.status(200).json({ connected: row.github_oauth_connected_at !== null, login: row.github_login });
}

export async function disconnectGithubAccount(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { error } = await supabase
    .from("profiles")
    .update({
      github_user_id: null,
      github_login: null,
      github_user_token_enc: null,
      github_oauth_scope: null,
      github_oauth_connected_at: null,
    })
    .eq("id", req.user!.id);

  if (error) {
    throw new HttpError(500, "Could not disconnect your GitHub account.");
  }

  res.status(200).json({ connected: false, login: null });
}

interface GithubTokenRow {
  github_user_token_enc: string | null;
}

export async function listMyGithubRepos(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("profiles")
    .select("github_user_token_enc")
    .eq("id", req.user!.id)
    .single();

  const row = data as GithubTokenRow | null;
  if (error || !row?.github_user_token_enc) {
    throw new HttpError(422, "Connect your GitHub account in Settings first.");
  }

  try {
    const repos = await listAuthenticatedUserRepos(decrypt(row.github_user_token_enc));
    res.status(200).json({ repos });
  } catch (err) {
    if (err instanceof GithubApiError) {
      throw new HttpError(err.status === 401 ? 401 : 502, err.message);
    }
    throw new HttpError(502, "Could not reach GitHub. Please try again.");
  }
}
