import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { encrypt } from "../lib/crypto.js";
import { GithubApiError, verifyConnection } from "../lib/github.js";
import { HttpError } from "../lib/http-error.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { ConnectGithubInput } from "../schemas/github.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface GithubConnectionRow {
  github_repo: string | null;
  github_default_branch: string | null;
  github_connected_at: string | null;
}

function toPublicConnection(row: GithubConnectionRow) {
  return {
    connected: row.github_connected_at !== null,
    repo: row.github_repo,
    defaultBranch: row.github_default_branch,
    connectedAt: row.github_connected_at,
  };
}

export async function getGithubStatus(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select("github_repo, github_default_branch, github_connected_at")
    .eq("id", req.project!.id)
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not load this project's GitHub connection.");
  }

  res.status(200).json(toPublicConnection(data as GithubConnectionRow));
}

export async function connectGithub(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { repo, token, baseBranch } = req.body as ConnectGithubInput;
  const supabase = userScopedClient(req);

  let defaultBranch: string;
  try {
    const verified = await verifyConnection({ repo, token });
    defaultBranch = baseBranch || verified.defaultBranch;
  } catch (err) {
    if (err instanceof GithubApiError) {
      throw new HttpError(422, err.message);
    }
    throw new HttpError(502, "Could not reach GitHub. Please try again.");
  }

  const { data, error } = await supabase
    .from("projects")
    .update({
      github_repo: repo,
      github_token_enc: encrypt(token),
      github_default_branch: defaultBranch,
      github_connected_at: new Date().toISOString(),
    })
    .eq("id", project.id)
    .select("github_repo, github_default_branch, github_connected_at")
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not save this GitHub connection.");
  }

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel: displayNameFromUser(req.user!),
    eventType: "ticket",
    summary: "connected GitHub",
    linkLabel: repo,
    linkTo: "settings",
    meta: defaultBranch,
  });

  res.status(200).json(toPublicConnection(data as GithubConnectionRow));
}

export async function disconnectGithub(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("projects")
    .update({
      github_repo: null,
      github_token_enc: null,
      github_default_branch: null,
      github_connected_at: null,
    })
    .eq("id", project.id)
    .select("github_repo, github_default_branch, github_connected_at")
    .single();

  if (error || !data) {
    throw new HttpError(500, "Could not disconnect GitHub.");
  }

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel: displayNameFromUser(req.user!),
    eventType: "ticket",
    summary: "disconnected GitHub",
  });

  res.status(200).json(toPublicConnection(data as GithubConnectionRow));
}
