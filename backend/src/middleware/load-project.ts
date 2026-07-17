import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

// Resolves :projectId into req.project for every route nested under
// /api/projects/:projectId/*. RLS on the projects table means a project
// this user doesn't own simply won't come back, so a missing row is
// reported as a plain 404 rather than a 403 (no ownership info leaked).
export async function loadProject(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const supabase = createUserScopedSupabaseClient(req.accessToken as string);
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, key_prefix")
    .eq("id", req.params.projectId)
    .maybeSingle();

  if (error) {
    next(new HttpError(500, "Could not load project."));
    return;
  }
  if (!data) {
    next(new HttpError(404, "Project not found"));
    return;
  }

  req.project = { id: data.id, name: data.name, keyPrefix: data.key_prefix };
  next();
}
