import type { Job } from "bullmq";
import { recordActivity } from "../lib/activity.js";
import { decrypt } from "../lib/crypto.js";
import { GithubApiError } from "../lib/github.js";
import { logger } from "../lib/logger.js";
import type { RepoScanJobData } from "../lib/queue.js";
import { runFullRepoScan } from "../lib/repo-scan.js";
import type { SlaPolicyDays } from "../lib/sla.js";
import { supabaseAdmin } from "../lib/supabase.js";

interface ScanProjectRow {
  sla_critical_days: number;
  sla_high_days: number;
  sla_medium_days: number;
  sla_low_days: number;
  github_repo: string | null;
  github_token_enc: string | null;
  github_default_branch: string | null;
  github_connected_at: string | null;
}

// The BullMQ processor for the "repo-scan" queue. Runs with no user
// session — supabaseAdmin (service-role) is the only option here, which is
// why every query below is manually scoped to project_id: there's no RLS
// safety net doing that for us the way there is in every HTTP controller.
export async function processRepoScanJob(job: Job<RepoScanJobData>): Promise<void> {
  const { scanId, projectId, baseSha, headSha } = job.data;
  const supabase = supabaseAdmin;

  // Guards against BullMQ's stalled-job redelivery (e.g. the worker process
  // restarting mid-scan, which happens routinely in dev under `tsx watch`):
  // a scan only ever starts out "Queued", so a second delivery of the same
  // job lands here with status already "Processing" (the first run is still
  // in flight, or died without updating it) or "Done"/"Failed" (the first
  // run already finished). Re-running runFullRepoScan in any of those cases
  // would call the AI scanner a second time over unchanged code — since its
  // output isn't deterministic, a finding the first pass flagged can simply
  // go undetected on the second, and getting treated as "resolved" would
  // auto-close its ticket (and push Done to Jira) even though nothing about
  // the underlying code, or its remediation PR, actually changed.
  const { data: existingScan } = await supabase.from("scans").select("status").eq("id", scanId).maybeSingle();
  if (existingScan && existingScan.status !== "Queued") {
    logger.warn({ scanId, projectId, status: existingScan.status }, "Skipping redelivered repo-scan job — already processed");
    return;
  }

  await supabase.from("scans").update({ status: "Processing", bullmq_job_id: job.id ?? null }).eq("id", scanId);

  try {
    const { data: projectRow, error: projectError } = await supabase
      .from("projects")
      .select("sla_critical_days, sla_high_days, sla_medium_days, sla_low_days, github_repo, github_token_enc, github_default_branch, github_connected_at")
      .eq("id", projectId)
      .single();

    if (projectError || !projectRow) {
      throw new Error("Project not found.");
    }
    const project = projectRow as ScanProjectRow;

    if (!project.github_connected_at || !project.github_repo || !project.github_token_enc || !project.github_default_branch) {
      // Covers the case where GitHub was disconnected after this scan was
      // queued but before the worker picked it up — a real, expected race,
      // not a bug, so it fails this scan cleanly rather than throwing raw.
      throw new Error("GitHub was disconnected before this scan could run.");
    }

    const github = {
      creds: { repo: project.github_repo, token: decrypt(project.github_token_enc) },
      defaultBranch: project.github_default_branch,
    };
    const slaPolicyDays: SlaPolicyDays = {
      Critical: project.sla_critical_days,
      High: project.sla_high_days,
      Medium: project.sla_medium_days,
      Low: project.sla_low_days,
    };

    const { data: projectServices } = await supabase.from("project_services").select("name").eq("project_id", projectId);
    const defaultService = projectServices?.length === 1 ? (projectServices[0]?.name ?? null) : null;

    const result = await runFullRepoScan({
      supabase,
      projectId,
      scanId,
      github,
      slaPolicyDays,
      defaultService,
      baseSha,
      headSha,
    });

    const { error: updateError } = await supabase
      .from("scans")
      .update({
        status: "Done",
        commit_sha: result.commitSha,
        base_commit_sha: baseSha,
        row_count: result.filesScanned,
        finding_count: result.findingCount,
        new_delta_count: result.counts.newDelta,
        changed_count: result.counts.changed,
        in_progress_count: result.counts.inProgress,
        resolved_count: result.counts.resolved,
      })
      .eq("id", scanId);
    if (updateError) {
      throw new Error("Scan finished but the result could not be saved.");
    }

    await supabase.from("projects").update({ status: "active" }).eq("id", projectId).eq("status", "not_connected");

    await recordActivity(supabase, {
      projectId,
      actorId: null,
      actorLabel: "AI Scan",
      eventType: "triage",
      summary: "completed an AI scan of",
      linkLabel: github.creds.repo,
      linkTo: "intake",
      meta: `${result.findingCount} findings · ${result.counts.newDelta} new · ${result.counts.changed} changed · ${result.counts.resolved} resolved`,
    });
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : err instanceof Error ? err.message : "AI repo scan failed.";
    logger.error({ err, projectId, scanId }, "AI repo scan job failed");
    await supabase.from("scans").update({ status: "Failed", error_message: message }).eq("id", scanId);
    // Rethrow so BullMQ records/retries the failure — the scans row above
    // is the user-facing state, this is for operational visibility.
    throw err;
  }
}
