import type { User } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { clearAuthCookies, readAuthCookies, setAuthCookies } from "../lib/auth-cookies.js";
import { assertArcjetAllowed } from "../lib/enforce-arcjet.js";
import { loginArcjet, signupArcjet } from "../lib/arcjet.js";
import { HttpError } from "../lib/http-error.js";
import { createRequestSupabaseClient, supabaseAdmin } from "../lib/supabase.js";
import type { LoginInput, SignupInput } from "../schemas/auth.schema.js";

function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: typeof user.user_metadata["full_name"] === "string" ? user.user_metadata["full_name"] : null,
  };
}

// Returned for both "signed up successfully, confirmation pending" and
// "email already has an account" so the response can't be used to enumerate
// registered addresses.
const SIGNUP_ACK_MESSAGE = "If that address isn't already registered, we've sent a confirmation email to it.";

export async function signup(req: Request, res: Response): Promise<void> {
  const { fullName, email, password } = req.body as SignupInput;

  const decision = await signupArcjet.protect(req, { email });
  assertArcjetAllowed(decision);

  const supabase = createRequestSupabaseClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${env.FRONTEND_ORIGIN}/login`,
    },
  });

  if (error) {
    if (error.code === "user_already_exists") {
      res.status(201).json({ status: "confirmation_required", message: SIGNUP_ACK_MESSAGE });
      return;
    }
    throw new HttpError(400, error.message);
  }

  // Supabase signals "email already registered" by returning a user with no
  // identities instead of an error, when email confirmations are enabled.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    res.status(201).json({ status: "confirmation_required", message: SIGNUP_ACK_MESSAGE });
    return;
  }

  if (!data.session) {
    res.status(201).json({ status: "confirmation_required", message: SIGNUP_ACK_MESSAGE });
    return;
  }

  setAuthCookies(res, {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
  });
  res.status(201).json({ status: "signed_in", user: toPublicUser(data.session.user) });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginInput;

  const decision = await loginArcjet.protect(req);
  assertArcjetAllowed(decision);

  const supabase = createRequestSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.code === "email_not_confirmed") {
      throw new HttpError(403, "Please confirm your email address before logging in.");
    }
    throw new HttpError(401, "Invalid email or password.");
  }

  setAuthCookies(res, {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
  });
  res.status(200).json({ status: "signed_in", user: toPublicUser(data.user) });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { accessToken } = readAuthCookies(req);

  if (accessToken) {
    // Revoke the refresh token server-side so a copy of it (if leaked)
    // can't be replayed after the user has logged out.
    await supabaseAdmin.auth.admin.signOut(accessToken, "global").catch(() => {
      // Token may already be expired/invalid — clearing cookies below is
      // still the correct outcome either way.
    });
  }

  clearAuthCookies(res);
  res.status(204).send();
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = readAuthCookies(req);

  if (!refreshToken) {
    throw new HttpError(401, "Not authenticated");
  }

  const supabase = createRequestSupabaseClient();
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session) {
    clearAuthCookies(res);
    throw new HttpError(401, "Session expired. Please log in again.");
  }

  setAuthCookies(res, {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
  });
  res.status(200).json({ status: "signed_in", user: toPublicUser(data.session.user) });
}

export function me(req: Request, res: Response): void {
  if (!req.user) {
    throw new HttpError(401, "Not authenticated");
  }
  res.status(200).json({ user: toPublicUser(req.user) });
}
