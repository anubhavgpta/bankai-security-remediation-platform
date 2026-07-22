import type { User } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { clearAuthCookies, readAuthCookies, setAuthCookies } from "../lib/auth-cookies.js";
import { assertArcjetAllowed } from "../lib/enforce-arcjet.js";
import { forgotPasswordArcjet, loginArcjet, signupArcjet } from "../lib/arcjet.js";
import { HttpError } from "../lib/http-error.js";
import { createRequestSupabaseClient, createUserScopedSupabaseClient, supabaseAdmin } from "../lib/supabase.js";
import type {
  ChangePasswordInput,
  DeleteAccountInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  SignupInput,
  UpdateProfileInput,
} from "../schemas/auth.schema.js";

// SSO-only accounts (Google/GitHub) never set a Bankai password — surfaced
// so the frontend can hide password-based flows (change password, the
// delete-account password confirmation) that would otherwise always fail
// "incorrect password" for them with nothing they can do about it.
function hasPasswordIdentity(user: User): boolean {
  return user.identities?.some((identity) => identity.provider === "email") ?? false;
}

function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: typeof user.user_metadata["full_name"] === "string" ? user.user_metadata["full_name"] : null,
    hasPassword: hasPasswordIdentity(user),
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

// Same wording regardless of whether the address has an account, so the
// response can't be used to enumerate registered addresses (mirrors
// SIGNUP_ACK_MESSAGE above).
const FORGOT_PASSWORD_ACK_MESSAGE = "If that address has an account, we've sent a password reset link to it.";

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = req.body as ForgotPasswordInput;

  const decision = await forgotPasswordArcjet.protect(req);
  assertArcjetAllowed(decision);

  const supabase = createRequestSupabaseClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.FRONTEND_ORIGIN}/reset-password`,
  });

  res.status(200).json({ message: FORGOT_PASSWORD_ACK_MESSAGE });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { accessToken, newPassword } = req.body as ResetPasswordInput;

  // A live recovery-session access token validates identically to a normal
  // session one (see require-auth.ts) — possessing it is exactly the proof
  // of identity we need, since it only reaches the caller via the emailed
  // recovery link.
  const supabase = createRequestSupabaseClient();
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user || !data.user.email) {
    throw new HttpError(401, "This reset link is invalid or has expired. Please request a new one.");
  }

  // Same admin-by-id path as changePassword: the user-scoped client's own
  // auth.updateUser always throws "Auth session missing!" no matter who
  // calls it, since it never has a real GoTrue session, only a manually-set
  // header/token.
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, { password: newPassword });
  if (updateError) {
    throw new HttpError(400, updateError.message);
  }

  // Mint a fresh, normal session now that the password is set, identical in
  // shape to login's — simpler than trying to reuse/extend the recovery
  // token's own session as a long-lived one.
  const signInClient = createRequestSupabaseClient();
  const { data: signInData, error: signInError } = await signInClient.auth.signInWithPassword({
    email: data.user.email,
    password: newPassword,
  });
  if (signInError || !signInData.session) {
    res.status(200).json({ status: "password_reset" });
    return;
  }

  setAuthCookies(res, {
    accessToken: signInData.session.access_token,
    refreshToken: signInData.session.refresh_token,
    expiresIn: signInData.session.expires_in,
  });
  res.status(200).json({ status: "signed_in", user: toPublicUser(signInData.session.user) });
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

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { fullName } = req.body as UpdateProfileInput;

  // Not createUserScopedSupabaseClient().auth.updateUser(...): that client
  // only carries an Authorization header, it never calls setSession(), and
  // GoTrue's updateUser goes through _useSession() internally regardless of
  // the header — so it always throws "Auth session missing!" no matter who's
  // calling it. The admin API updates by id directly and has no such
  // dependency, which is why it's used here instead.
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(req.user!.id, { user_metadata: { full_name: fullName } });
  if (error || !data.user) {
    throw new HttpError(400, error?.message ?? "Could not update your profile.");
  }

  // profiles.full_name is only kept in sync by a trigger on insert — mirror
  // the change explicitly here so anything reading from profiles (not
  // auth.users) doesn't see stale data.
  const supabase = createUserScopedSupabaseClient(req.accessToken as string);
  await supabase.from("profiles").update({ full_name: fullName }).eq("id", req.user!.id);

  res.status(200).json({ user: toPublicUser(data.user) });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;
  const email = req.user!.email;

  if (!email) {
    throw new HttpError(400, "This account has no email on file.");
  }

  // Supabase's updateUser trusts the current session and doesn't itself
  // check the old password, so we verify it ourselves first with a
  // throwaway sign-in before allowing the change.
  const verifyClient = createRequestSupabaseClient();
  const { error: verifyError } = await verifyClient.auth.signInWithPassword({ email, password: currentPassword });
  if (verifyError) {
    throw new HttpError(401, "Current password is incorrect.");
  }

  // Same reason as updateProfile: the user-scoped client's auth.updateUser
  // would throw "Auth session missing!" regardless of who calls it, since
  // it never has a real GoTrue session, only a manually-set header.
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user!.id, { password: newPassword });
  if (error) {
    throw new HttpError(400, error.message);
  }

  res.status(204).send();
}

// Deletes the auth.users row via the admin API — profiles.id FKs to it
// `on delete cascade` (20260717120000_create_profiles.sql), which in turn
// cascades to every project this user owns (and everything in those
// projects: scans/findings/tickets/activity/members/invites), plus their
// own project_members rows in anyone else's projects. This is strictly
// more destructive than deleting a single project, so it requires the
// same re-verify-current-password step as changePassword, just for an
// irreversible action instead of a sensitive one — except for SSO-only
// accounts, which have no password to verify: their already-authenticated
// session (requireAuth) plus the exact-email-match confirmation the
// frontend requires before submitting is the only proof of intent
// available, same bar every other authenticated-but-unverified mutation
// in this app relies on.
export async function deleteAccount(req: Request, res: Response): Promise<void> {
  const { password } = req.body as DeleteAccountInput;
  const email = req.user!.email;

  if (!email) {
    throw new HttpError(400, "This account has no email on file.");
  }

  if (hasPasswordIdentity(req.user!)) {
    if (!password) {
      throw new HttpError(401, "Password is incorrect.");
    }
    const verifyClient = createRequestSupabaseClient();
    const { error: verifyError } = await verifyClient.auth.signInWithPassword({ email, password });
    if (verifyError) {
      throw new HttpError(401, "Password is incorrect.");
    }
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user!.id);
  if (error) {
    throw new HttpError(500, "Could not delete your account.");
  }

  clearAuthCookies(res);
  res.status(204).send();
}
