import { Router } from "express";
import {
  authorizeGithubAccount,
  disconnectGithubAccount,
  getGithubAccountStatus,
  githubAccountCallback,
  listMyGithubRepos,
} from "../controllers/github-oauth.controller.js";
import { requireAuth } from "../middleware/require-auth.js";

// Mounted at /api/auth/github by auth.routes.ts. This connects GitHub to an
// already-logged-in user, it is never itself a way to log into Bankai. The
// callback verifies the signed OAuth `state` instead of requireAuth, because
// cross-origin dev tunnels may not send the session cookie on GitHub's return
// navigation.
export const githubOAuthRouter = Router();

githubOAuthRouter.get("/authorize", requireAuth, authorizeGithubAccount);
githubOAuthRouter.get("/callback", githubAccountCallback);
githubOAuthRouter.get("/status", requireAuth, getGithubAccountStatus);
githubOAuthRouter.post("/disconnect", requireAuth, disconnectGithubAccount);
githubOAuthRouter.get("/repos", requireAuth, listMyGithubRepos);
