import type { Request, Response } from "express";
import { toPublicActivityEvent } from "../lib/activity.js";
import { HttpError } from "../lib/http-error.js";
import type { Severity } from "../lib/pipeline-types.js";
import { computeSlaStatus } from "../lib/sla.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

const SEVERITY_ORDER: Severity[] = ["Critical", "High", "Medium", "Low"];

export async function getOverview(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const projectId = req.project!.id;

  const [findingsRes, ticketsRes, scansRes, activityRes] = await Promise.all([
    supabase
      .from("findings")
      .select("id, severity, service, bucket, sla_due_date, source")
      .eq("project_id", projectId)
      .neq("source", "jira_import"),
    supabase.from("tickets").select("id, status, created_at, updated_at").eq("project_id", projectId),
    supabase
      .from("scans")
      .select("id, row_count, created_at, status")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    supabase
      .from("activity_events")
      .select("id, event_type, actor_label, summary, link_label, link_to, meta, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  if (findingsRes.error || ticketsRes.error || scansRes.error || activityRes.error) {
    throw new HttpError(500, "Could not load the project overview.");
  }

  const findings = findingsRes.data ?? [];
  const open = findings.filter((f) => f.bucket !== "Resolved");
  const withSla = open.map((f) => ({ ...f, slaStatus: computeSlaStatus(f.severity as Severity, f.sla_due_date, req.project!.slaPolicyDays) }));

  // "Total CVITs" is every CVIT scanned for this project, resolved or not.
  const totalCvits = findings.length;
  // The risk views below (SLA %, severity split) describe current exposure, so
  // they stay scoped to still-open findings via openCount.
  const openCount = open.length;
  const missed = withSla.filter((f) => f.slaStatus === "Missed").length;
  const slaBreachedPct = openCount > 0 ? Math.round((missed / openCount) * 1000) / 10 : 0;

  const tickets = ticketsRes.data ?? [];
  const openTickets = tickets.filter((t) => t.status !== "Done").length;
  const inReviewTickets = tickets.filter((t) => t.status === "In Review").length;
  const doneTickets = tickets.filter((t) => t.status === "Done");
  const meanTimeToRemediateDays =
    doneTickets.length > 0
      ? Math.round(
          (doneTickets.reduce(
            (sum, t) => sum + (new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) / 86_400_000,
            0,
          ) /
            doneTickets.length) *
            10,
        ) / 10
      : 0;

  const severityCounts: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of open) severityCounts[f.severity as Severity]++;
  const severityDistribution = SEVERITY_ORDER.map((label) => ({
    label,
    count: severityCounts[label],
    pct: openCount > 0 ? Math.round((severityCounts[label] / openCount) * 100) : 0,
  }));

  const serviceMap = new Map<string, { total: number; missed: number; approaching: number; onTrack: number }>();
  for (const f of withSla) {
    const key = f.service ?? "Unassigned";
    const bucket = serviceMap.get(key) ?? { total: 0, missed: 0, approaching: 0, onTrack: 0 };
    bucket.total++;
    if (f.slaStatus === "Missed") bucket.missed++;
    else if (f.slaStatus === "Approaching") bucket.approaching++;
    else bucket.onTrack++;
    serviceMap.set(key, bucket);
  }
  const serviceBreakdown = Array.from(serviceMap.entries()).map(([name, v]) => ({ name, ...v }));

  const trend = (scansRes.data ?? [])
    .filter((s) => s.status === "Done")
    .map((s) => ({ date: s.created_at, totalFindings: s.row_count }));

  res.status(200).json({
    overview: {
      kpis: { totalCvits, slaBreachedPct, openTickets, inReviewTickets, meanTimeToRemediateDays },
      severityDistribution,
      serviceBreakdown,
      trend,
      recentActivity: (activityRes.data ?? []).map(toPublicActivityEvent),
    },
  });
}
