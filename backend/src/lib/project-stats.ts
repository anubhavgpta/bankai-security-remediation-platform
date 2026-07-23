import type { SupabaseClient } from "@supabase/supabase-js";
import type { Severity } from "./pipeline-types.js";
import { computeSlaStatus, type SlaPolicyDays } from "./sla.js";

export interface ProjectStats {
  totalCvits: number;
  slaBreachedPct: number;
  openTickets: number;
  lastIntakeAt: string | null;
}

export async function computeProjectStats(supabase: SupabaseClient, projectId: string, policyDays: SlaPolicyDays): Promise<ProjectStats> {
  const [findingsRes, ticketsRes, scanRes] = await Promise.all([
    supabase
      .from("findings")
      .select("severity, bucket, sla_due_date, source")
      .eq("project_id", projectId)
      .neq("source", "jira_import"),
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

  const findings = findingsRes.data ?? [];
  const open = findings.filter((f) => f.bucket !== "Resolved");
  const missed = open.filter((f) => computeSlaStatus(f.severity as Severity, f.sla_due_date, policyDays) === "Missed").length;
  // "Total CVITs" is every CVIT this project has scanned, including ones since
  // resolved — jira-imported findings are already excluded by the query above.
  const totalCvits = findings.length;
  // SLA breach rate stays scoped to still-open findings: a resolved finding
  // can't breach, so it must not sit in the denominator.
  const slaBreachedPct = open.length > 0 ? Math.round((missed / open.length) * 1000) / 10 : 0;
  const openTickets = (ticketsRes.data ?? []).filter((t) => t.status !== "Done").length;

  return {
    totalCvits,
    slaBreachedPct,
    openTickets,
    lastIntakeAt: (scanRes.data as { created_at: string } | null)?.created_at ?? null,
  };
}
