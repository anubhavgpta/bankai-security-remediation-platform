import type { SupabaseClient } from "@supabase/supabase-js";
import type { Severity } from "./pipeline-types.js";
import { computeSlaStatus } from "./sla.js";

export interface ProjectStats {
  totalCvits: number;
  slaBreachedPct: number;
  openTickets: number;
  lastIntakeAt: string | null;
}

export async function computeProjectStats(supabase: SupabaseClient, projectId: string): Promise<ProjectStats> {
  const [findingsRes, ticketsRes, scanRes] = await Promise.all([
    supabase.from("findings").select("severity, bucket, sla_due_date").eq("project_id", projectId),
    supabase.from("tickets").select("status").eq("project_id", projectId),
    supabase
      .from("scans")
      .select("created_at")
      .eq("project_id", projectId)
      .eq("status", "Done")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const open = (findingsRes.data ?? []).filter((f) => f.bucket !== "Resolved");
  const missed = open.filter((f) => computeSlaStatus(f.severity as Severity, f.sla_due_date) === "Missed").length;
  const totalCvits = open.length;
  const slaBreachedPct = totalCvits > 0 ? Math.round((missed / totalCvits) * 1000) / 10 : 0;
  const openTickets = (ticketsRes.data ?? []).filter((t) => t.status !== "Done").length;

  return {
    totalCvits,
    slaBreachedPct,
    openTickets,
    lastIntakeAt: (scanRes.data as { created_at: string } | null)?.created_at ?? null,
  };
}
