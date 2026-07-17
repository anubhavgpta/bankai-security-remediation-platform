import type { Request, Response } from "express";
import { toPublicActivityEvent } from "../lib/activity.js";
import { HttpError } from "../lib/http-error.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

export async function listActivity(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  let query = supabase
    .from("activity_events")
    .select("id, event_type, actor_label, summary, link_label, link_to, meta, created_at")
    .eq("project_id", req.project!.id);

  const { type, actor } = req.query;
  if (typeof type === "string" && type !== "all") query = query.eq("event_type", type);
  if (typeof actor === "string" && actor !== "all") query = query.eq("actor_label", actor);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
  if (error) {
    throw new HttpError(500, "Could not load activity.");
  }

  res.status(200).json({ activity: (data ?? []).map(toPublicActivityEvent) });
}
