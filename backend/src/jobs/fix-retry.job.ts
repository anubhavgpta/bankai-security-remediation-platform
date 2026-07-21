import type { Job } from "bullmq";
import { recordActivity } from "../lib/activity.js";
import { generateFix, type FixFindingInput } from "../lib/gemini-fix.js";
import {
  commitFileToBranch,
  createPullRequestComment,
  getBlob,
  getBranchHeadSha,
  getJobLogs,
  getTree,
  getWorkflowRunJobs,
  GithubApiError,
} from "../lib/github.js";
import { addFixRetryComment } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { PIPELINE_STAGE_LABELS, type PipelineStageName } from "../lib/pipeline-types.js";
import { enqueuePipelineRetry, type FixRetryJobData } from "../lib/queue.js";
import { loadGithubCreds, loadJiraCreds } from "../lib/ticketing.js";
import { supabaseAdmin } from "../lib/supabase.js";

const MAX_FIX_ATTEMPTS = 3;

interface FixRetryTicketRow {
  id: string;
  status: string;
  github_branch_name: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_fix_commit_sha: string | null;
  jira_issue_key: string | null;
  ci_fix_attempt: number;
  finding_id: string;
  findings: FixRetryFindingRow | FixRetryFindingRow[] | null;
}

interface FixRetryFindingRow {
  title: string;
  cwe: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  description: string | null;
  rationale: string | null;
  remediation_guidance: string | null;
}

const SELECT_FIX_RETRY_TICKET =
  "id, status, github_branch_name, github_pr_number, github_pr_url, github_fix_commit_sha, jira_issue_key, ci_fix_attempt, finding_id, findings ( title, cwe, file_path, line_start, line_end, description, rationale, remediation_guidance )";

async function setTicketError(ticketId: string, message: string): Promise<void> {
  await supabaseAdmin.from("tickets").update({ github_pr_error: message }).eq("id", ticketId);
}

function stageLabel(name: string): string {
  return PIPELINE_STAGE_LABELS[name as PipelineStageName] ?? name;
}

function buildRetryMarkdown(input: { attempt: number; failedStage: string; summary: string; commitUrl: string }): string {
  return (
    `## 🔁 Bankai Verification Pipeline — retrying (attempt ${input.attempt} of ${MAX_FIX_ATTEMPTS})\n\n` +
    `❌ **${stageLabel(input.failedStage)}** failed.\n\n` +
    `Regenerated fix: ${input.summary}\n\n` +
    `Re-running verification against [this commit](${input.commitUrl})...`
  );
}

function buildExhaustedMarkdown(input: { failedStage: string; summary: string | null }): string {
  return (
    `## 🤖 Bankai Verification Pipeline — needs a human\n\n` +
    `❌ **${stageLabel(input.failedStage)}** failed.\n\n` +
    (input.summary
      ? `Bankai could not produce a further fix: ${input.summary}`
      : "Bankai could not produce a further fix. A human needs to review and edit the code directly.")
  );
}

// The BullMQ processor for the "fix-retry" queue: when the CI verification
// pipeline fails on a code-level stage (build/functional-test/integration-test),
// this regenerates the fix with the failure log as extra context, commits it
// to the SAME remediation branch (never a new PR), and re-dispatches CI —
// up to MAX_FIX_ATTEMPTS total fix attempts, then leaves the ticket at its
// existing terminal ci_status: "failed" for a human to take over.
//
// Re-checks the ticket's own state on every run, same idempotency contract
// as fix-pr.job.ts/pipeline.job.ts — safe to re-run for the same ticket.
export async function processFixRetryJob(job: Job<FixRetryJobData>): Promise<void> {
  const { ticketId, projectId, githubRunId, failingStage } = job.data;
  const supabase = supabaseAdmin;

  const { data: ticketData, error: ticketError } = await supabase
    .from("tickets")
    .select(SELECT_FIX_RETRY_TICKET)
    .eq("id", ticketId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (ticketError || !ticketData) {
    logger.error({ err: ticketError, ticketId, projectId }, "fix-retry job: ticket not found");
    return;
  }
  const ticket = ticketData as FixRetryTicketRow;
  const finding = Array.isArray(ticket.findings) ? ticket.findings[0] : ticket.findings;

  if (ticket.status === "Done") return;
  if (!ticket.github_branch_name || !ticket.github_pr_number) return;
  if (!finding || !finding.file_path) return;
  if (ticket.ci_fix_attempt >= MAX_FIX_ATTEMPTS) return;

  const github = await loadGithubCreds(supabase, projectId);
  if (!github) {
    // GitHub was disconnected after this job was enqueued but before the
    // worker picked it up — a real race, not a bug.
    return;
  }
  const jira = await loadJiraCreds(supabase, projectId);

  const branch = ticket.github_branch_name;
  const findingInput: FixFindingInput = {
    title: finding.title,
    cwe: finding.cwe,
    filePath: finding.file_path,
    lineStart: finding.line_start,
    lineEnd: finding.line_end,
    evidence: finding.description ?? finding.rationale ?? "",
    remediationGuidance: finding.remediation_guidance ?? "",
  };

  try {
    const headSha = await getBranchHeadSha(github.creds, branch);
    const tree = await getTree(github.creds, branch);
    const entry = tree.find((e) => e.path === finding.file_path);
    if (!entry) {
      await setTicketError(ticketId, `"${finding.file_path}" no longer exists on this branch.`);
      return;
    }
    const fileContent = await getBlob(github.creds, entry.sha);

    // Best-effort — a missing log just means generateFix gets less context,
    // never blocks the retry attempt (getJobLogs/getWorkflowRunJobs already
    // never throw).
    let failureLog: string | null = null;
    const jobs = await getWorkflowRunJobs(github.creds, githubRunId).catch((err) => {
      logger.warn({ err, githubRunId, ticketId }, "Could not list workflow run jobs for a fix-retry attempt");
      return [];
    });
    const failedJob = jobs.find((j) => j.name === failingStage);
    if (failedJob) {
      failureLog = await getJobLogs(github.creds, failedJob.id);
    }

    const attemptNumber = ticket.ci_fix_attempt + 1;
    const fix = await generateFix(findingInput, fileContent, {
      attempt: attemptNumber,
      maxAttempts: MAX_FIX_ATTEMPTS,
      failedStage: failingStage,
      failureLog,
    });

    const reason = failedJob?.conclusion ? `concluded "${failedJob.conclusion}"` : "did not complete successfully";

    if (!fix || !fix.confident || fix.fixedContent === fileContent) {
      // Terminal — Gemini either couldn't improve the fix or explicitly
      // flagged this as a dead end (e.g. the failing test requires the
      // vulnerability to remain). Don't consume ci_fix_attempt further and
      // don't re-dispatch CI; the ticket stays at its existing ci_status:
      // "failed" from the pipeline run that triggered this job.
      await setTicketError(ticketId, fix?.summary ?? "Could not generate a further automatic fix after a CI failure.");

      if (ticket.github_pr_number) {
        const comment = buildExhaustedMarkdown({ failedStage: failingStage, summary: fix?.summary ?? null });
        const posted = await createPullRequestComment(github.creds, ticket.github_pr_number, comment);
        if (!posted.ok) {
          logger.error({ status: posted.status, message: posted.message, ticketId, projectId }, "Could not post the fix-retry-exhausted comment on PR");
        }
      }
      if (jira && ticket.jira_issue_key) {
        const posted = await addFixRetryComment(jira.creds, ticket.jira_issue_key, {
          kind: "exhausted",
          failedStage: failingStage,
          reason,
          summary: fix?.summary ?? null,
        });
        if (!posted.ok) {
          logger.error({ status: posted.status, message: posted.message, ticketId, projectId }, "Could not post the fix-retry-exhausted comment on Jira");
        }
      }
      return;
    }

    const { commitSha } = await commitFileToBranch(github.creds, {
      branch,
      baseSha: headSha,
      message: `fix: retry ${attemptNumber} — ${finding.title}\n\n${fix.summary}\n\nAutomatically regenerated by Bankai AI after a CI failure.`,
      path: finding.file_path,
      content: fix.fixedContent,
    });

    await supabase
      .from("tickets")
      .update({
        github_fix_commit_sha: commitSha,
        ci_fix_attempt: attemptNumber,
        ci_status: null,
        ci_run_url: null,
        github_pr_error: null,
      })
      .eq("id", ticketId);

    const commitUrl = `https://github.com/${github.creds.repo}/commit/${commitSha}`;

    if (ticket.github_pr_number) {
      const comment = buildRetryMarkdown({ attempt: attemptNumber, failedStage: failingStage, summary: fix.summary, commitUrl });
      const posted = await createPullRequestComment(github.creds, ticket.github_pr_number, comment);
      if (!posted.ok) {
        logger.error({ status: posted.status, message: posted.message, ticketId, projectId }, "Could not post the fix-retry comment on PR");
      }
    }
    if (jira && ticket.jira_issue_key) {
      const posted = await addFixRetryComment(jira.creds, ticket.jira_issue_key, {
        kind: "retrying",
        attempt: attemptNumber,
        maxAttempts: MAX_FIX_ATTEMPTS,
        failedStage: failingStage,
        reason,
        summary: fix.summary,
        commitUrl,
      });
      if (!posted.ok) {
        logger.error({ status: posted.status, message: posted.message, ticketId, projectId }, "Could not post the fix-retry comment on Jira");
      }
    }

    // Fire-and-forget, same contract as fix-pr.job.ts's enqueuePipelineVerification
    // call — ci_bootstrap_status is already 'ready' at this point (a full
    // pipeline run already completed to get here), so processPipelineJob
    // skips straight to dispatch.
    enqueuePipelineRetry({ ticketId, projectId }).catch((err) => {
      logger.error({ err, ticketId, projectId }, "Could not re-enqueue the CI verification pipeline after a fix retry");
    });

    await recordActivity(supabase, {
      projectId,
      actorId: null,
      actorLabel: "Bankai AI",
      eventType: "pipeline",
      summary: "regenerated a fix after a CI failure for",
      linkTo: "tickets",
      meta: `${finding.title} · attempt ${attemptNumber} of ${MAX_FIX_ATTEMPTS}`,
    });
  } catch (err) {
    // An infra-level failure (GithubApiError, etc.) must not consume a
    // retry attempt — ci_fix_attempt is only bumped on a successful commit
    // above. A human still has the manual "Retry CI" button as a fallback,
    // which re-runs CI against the same (already-committed) code.
    const message = err instanceof GithubApiError ? err.message : "Could not regenerate and commit a fix after a CI failure.";
    logger.error({ err, ticketId, projectId }, "fix-retry job failed");
    await setTicketError(ticketId, message);
  }
}
