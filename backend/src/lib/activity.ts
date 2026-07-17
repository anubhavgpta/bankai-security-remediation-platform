import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

export interface RecordActivityInput {
  projectId: string;
  actorId: string | null;
  actorLabel: string;
  eventType: "upload" | "triage" | "ticket" | "sla";
  summary: string;
  linkLabel?: string | null;
  linkTo?: string | null;
  meta?: string | null;
}

// Best-effort: a failed audit-log write shouldn't fail the request that
// triggered it (a scan upload, a ticket creation, ...), so errors are
// logged rather than thrown.
export async function recordActivity(supabase: SupabaseClient, input: RecordActivityInput): Promise<void> {
  const { error } = await supabase.from("activity_events").insert({
    project_id: input.projectId,
    actor_id: input.actorId,
    actor_label: input.actorLabel,
    event_type: input.eventType,
    summary: input.summary,
    link_label: input.linkLabel ?? null,
    link_to: input.linkTo ?? null,
    meta: input.meta ?? null,
  });

  if (error) {
    logger.error({ err: error, input }, "Failed to record activity event");
  }
}

interface ActivityEventRow {
  id: string;
  event_type: string;
  actor_label: string;
  summary: string;
  link_label: string | null;
  link_to: string | null;
  meta: string | null;
  created_at: string;
}

export function toPublicActivityEvent(row: ActivityEventRow) {
  return {
    id: row.id,
    type: row.event_type,
    actor: row.actor_label,
    summary: row.summary,
    linkLabel: row.link_label,
    linkTo: row.link_to,
    meta: row.meta,
    createdAt: row.created_at,
  };
}
