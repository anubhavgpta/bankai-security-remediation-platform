import { Router } from "express";
import {
  changePassword,
  deleteAccount,
  forgotPassword,
  login,
  logout,
  me,
  refresh,
  resetPassword,
  signup,
  updateProfile,
} from "../controllers/auth.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  updateProfileSchema,
} from "../schemas/auth.schema.js";
import { githubOAuthRouter } from "./github-oauth.routes.js";
import { ssoRouter } from "./sso.routes.js";

export const authRouter = Router();

authRouter.post("/signup", validateBody(signupSchema), signup);
authRouter.post("/login", validateBody(loginSchema), login);
authRouter.post("/forgot-password", validateBody(forgotPasswordSchema), forgotPassword);
authRouter.post("/reset-password", baselineProtect, validateBody(resetPasswordSchema), resetPassword);
authRouter.post("/logout", logout);
authRouter.post("/refresh", refresh);
authRouter.get("/session", requireAuth, me);
authRouter.patch("/profile", requireAuth, baselineProtect, validateBody(updateProfileSchema), updateProfile);
authRouter.patch("/password", requireAuth, baselineProtect, validateBody(changePasswordSchema), changePassword);
authRouter.delete("/account", requireAuth, baselineProtect, validateBody(deleteAccountSchema), deleteAccount);

// Connecting a GitHub account (for repo scanning) is unrelated to Bankai's
// own session/login above — see github-oauth.routes.ts.
authRouter.use("/github", githubOAuthRouter);

// "Log in with Google/GitHub" via Supabase's own OAuth integration — see
// sso.routes.ts.
authRouter.use("/sso", ssoRouter);
