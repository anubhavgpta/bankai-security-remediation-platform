import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { CI_BOOTSTRAP_BRANCH, CI_WORKFLOW_FILE } from "../lib/ci-template.js";
import { decrypt } from "../lib/crypto.js";
import { createPullRequestComment, getWorkflowRunJobs, type WorkflowRunJob } from "../lib/github.js";
import { addPipelineEvidenceComment } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { PIPELINE_STAGE_LABELS, type PipelineStageName } from "../lib/pipeline-types.js";
import { enqueueFixRetry, enqueuePipelineRetry, enqueueRepoScan } from "../lib/queue.js";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  loadGithubCreds,
  loadJiraCreds,
  markBootstrapPrMerged,
  markTicketPipelineResult,
  markTicketPrClosedWithoutMerge,
  markTicketPrMerged,
} from "../lib/ticketing.js";

interface WebhookProjectRow {
  github_default_branch: string | null;
  github_webhook_secret_enc: string | null;
  github_connected_at: string | null;
}

interface GithubPushPayload {
  ref?: string;
  before?: string;
  after?: string;
  deleted?: boolean;
}

interface GithubPullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: { merged?: boolean; head?: { ref?: string } };
}

interface GithubWorkflowRunPayload {
  action?: string;
  workflow_run?: {
    id: number;
    head_branch: string;
    path: string;
    status: string;
    conclusion: string | null;
    html_url: string;
  };
}

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  // timingSafeEqual throws on length mismatch rather than returning false —
  // guard explicitly so a wrong-length header can't crash the request.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// No requireAuth/originCheck/session in this path — GitHub calls this
// directly, server-to-server, with no cookie and (usually) no Origin
// header. The HMAC signature against this project's own webhook secret is
// the entire trust boundary here; every branch below fails closed.
export async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    // Would mean express.raw() wasn't applied to this route — a wiring bug,
    // not something a real request from GitHub could trigger.
    res.status(400).end();
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("github_default_branch, github_webhook_secret_enc, github_connected_at")
    .eq("id", projectId)
    .maybeSingle();

  const project = data as WebhookProjectRow | null;
  if (error || !project || !project.github_connected_at || !project.github_webhook_secret_enc) {
    res.status(404).end();
    return;
  }

  const secret = decrypt(project.github_webhook_secret_enc);
  if (!verifySignature(secret, rawBody, req.get("x-hub-signature-256"))) {
    logger.warn({ projectId }, "GitHub webhook signature verification failed");
    res.status(401).end();
    return;
  }

  const event = req.get("x-github-event");
  if (event === "ping") {
    res.status(200).json({ ok: true });
    return;
  }
  if (event === "pull_request") {
    await handlePullRequestEvent(projectId, rawBody, res);
    return;
  }
  if (event === "workflow_run") {
    await handleWorkflowRunEvent(projectId, rawBody, res);
    return;
  }
  if (event !== "push") {
    res.status(200).json({ ignored: true });
    return;
  }

  let payload: GithubPushPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubPushPayload;
  } catch {
    res.status(400).end();
    return;
  }

  const branch = (payload.ref ?? "").replace(/^refs\/heads\//, "");

  // Never scan pushes to the bot's own remediation branches — creating
  // tickets from a scan can itself lead to pushes on remediation/*
  // branches, and re-scanning those would be pointless busywork at best
  // and a feedback loop at worst.
  if (branch.startsWith("remediation/")) {
    res.status(200).json({ ignored: true });
    return;
  }
  if (!project.github_default_branch || branch !== project.github_default_branch) {
    res.status(200).json({ ignored: true });
    return;
  }
  if (payload.deleted || !payload.before || !payload.after) {
    res.status(200).json({ ignored: true });
    return;
  }

  const { data: scan, error: scanError } = await supabaseAdmin
    .from("scans")
    .insert({
      project_id: projectId,
      source: "github_ai",
      status: "Queued",
      trigger_type: "webhook",
      branch,
      base_commit_sha: payload.before,
      commit_sha: payload.after,
    })
    .select("id")
    .single();

  if (scanError || !scan) {
    logger.error({ err: scanError, projectId }, "Could not record a scan row for a GitHub webhook push");
    res.status(500).end();
    return;
  }

  await enqueueRepoScan(
    { scanId: scan.id, projectId, triggerType: "webhook", baseSha: payload.before, headSha: payload.after },
    `webhook-${projectId}-${payload.after}`,
  );

  // GitHub enforces a short response timeout on webhook deliveries and
  // marks them failed/retries otherwise — the scan itself runs in the
  // worker, never in this request.
  res.status(202).json({ queued: true });
}

// Signature verification already happened in handleGithubWebhook before this
// is called — same trust boundary as the push handling above. Only
// "closed" is interesting here: "opened"/"synchronize"/etc. carry nothing
// Bankai needs to act on (the ticket already moved to "In Review" when the
// fix-pr job itself opened the PR).
async function handlePullRequestEvent(projectId: string, rawBody: Buffer, res: Response): Promise<void> {
  let payload: GithubPullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubPullRequestPayload;
  } catch {
    res.status(400).end();
    return;
  }

  if (payload.action !== "closed" || typeof payload.number !== "number") {
    res.status(200).json({ ignored: true });
    return;
  }

  // The CI-bootstrap PR (adds bankai-verify.yml to the default branch) is
  // not a remediation PR — its closed/merged transition drives
  // ci_bootstrap_status, not a ticket's status.
  if (payload.pull_request?.head?.ref === CI_BOOTSTRAP_BRANCH) {
    if (payload.pull_request.merged) {
      const pendingTicketIds = await markBootstrapPrMerged(supabaseAdmin, projectId);
      for (const ticketId of pendingTicketIds) {
        // enqueuePipelineRetry, not enqueuePipelineVerification: every
        // pending ticket here already ran its pipeline job once (that run
        // is what left it at 'pending_setup' in the first place), so it
        // already occupies the `ci-pipeline-${ticketId}` id. Re-adding under
        // that same id would silently no-op — this needs a fresh id, same
        // as the ticket-level "Retry CI" action.
        enqueuePipelineRetry({ ticketId, projectId }).catch((err) => {
          logger.error({ err, ticketId, projectId }, "Could not re-enqueue pipeline verification after CI bootstrap merge");
        });
      }
    } else {
      // Closed without merge — reset to 'none' so a future ticket's
      // pipeline job can retry opening the bootstrap PR instead of being
      // stuck waiting on one that will never merge.
      const { error } = await supabaseAdmin
        .from("projects")
        .update({ ci_bootstrap_status: "none", ci_bootstrap_pr_url: null })
        .eq("id", projectId);
      if (error) {
        logger.error({ err: error, projectId }, "Could not reset CI bootstrap status after its PR was closed unmerged");
      }
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (payload.pull_request?.merged) {
    await markTicketPrMerged(supabaseAdmin, { projectId, prNumber: payload.number });
  } else {
    await markTicketPrClosedWithoutMerge(supabaseAdmin, { projectId, prNumber: payload.number });
  }

  res.status(200).json({ ok: true });
}

// Kept in sync with fix-retry.job.ts's own MAX_FIX_ATTEMPTS — both cap the
// same counter (tickets.ci_fix_attempt), just from either side of the loop.
const MAX_FIX_ATTEMPTS = 3;
const RETRYABLE_STAGES: PipelineStageName[] = ["build", "functional-test", "integration-test"];

function stageIcon(conclusion: string | null): string {
  if (conclusion === "success") return "✅";
  if (conclusion === "failure") return "❌";
  if (conclusion === "cancelled" || conclusion === "skipped") return "⏭️";
  return "⚠️";
}

function stageLabel(name: string): string {
  return PIPELINE_STAGE_LABELS[name as PipelineStageName] ?? name;
}

function buildEvidenceComment(input: { passed: boolean; stages: WorkflowRunJob[]; runUrl: string; retryNote?: string | undefined }): string {
  const rows = input.stages.length
    ? input.stages.map((s) => `| ${stageLabel(s.name)} | ${stageIcon(s.conclusion)} ${s.conclusion ?? s.status} |`).join("\n")
    : "| _(no per-stage detail available)_ | — |";
  const cdSuccess = input.passed
    ? "\n\n**CD Successful** — Build, Image, and Deploy Dev (CD) all completed, and both test stages passed."
    : "";
  const verdict =
    (input.passed
      ? "✅ **All 5 stages passed — this branch is verified and ready to merge.** A human still needs to review " +
        "the diff and click Merge on GitHub — Bankai never merges automatically."
      : "❌ **Verification failed.** Review the failing stage's logs via the run link below before merging — " +
        "Bankai never merges automatically.") + (input.retryNote ? ` ${input.retryNote}` : "");
  return (
    `## 🤖 Bankai Verification Pipeline\n\n` +
    `| Stage | Result |\n| --- | --- |\n${rows}${cdSuccess}\n\n` +
    `${verdict}\n\n[View full run →](${input.runUrl})`
  );
}

// Same trust boundary as handlePullRequestEvent — signature already
// verified in handleGithubWebhook. Only "completed" runs of Bankai's own
// bankai-verify.yml are acted on; other workflows or in-progress runs in
// this repo carry nothing Bankai needs to react to.
async function handleWorkflowRunEvent(projectId: string, rawBody: Buffer, res: Response): Promise<void> {
  let payload: GithubWorkflowRunPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubWorkflowRunPayload;
  } catch {
    res.status(400).end();
    return;
  }

  const run = payload.workflow_run;
  if (payload.action !== "completed" || !run || !run.path.endsWith(`/${CI_WORKFLOW_FILE}`)) {
    res.status(200).json({ ignored: true });
    return;
  }

  // Matched by branch on the tickets table itself, not pipeline_runs —
  // github_branch_name is unique per ticket (buildBranchName derives it
  // from the finding's own fingerprint) and is set the moment the branch is
  // created, well before any pipeline_runs row exists. Matching this way
  // avoids a real race with pipeline.job.ts's post-dispatch poll: the
  // scaffold workflow's placeholder steps are trivial `echo` commands that
  // can complete (and fire this webhook) before that poll ever inserts a
  // pipeline_runs row to match against.
  const { data: ticketRow, error: ticketError } = await supabaseAdmin
    .from("tickets")
    .select("id, github_pr_number, github_pr_url, jira_issue_key, ci_fix_attempt")
    .eq("project_id", projectId)
    .eq("github_branch_name", run.head_branch)
    .maybeSingle();

  if (ticketError || !ticketRow) {
    // Not a branch Bankai created a ticket for (e.g. someone ran this
    // workflow manually on an unrelated branch) — nothing to correlate.
    res.status(200).json({ ignored: true });
    return;
  }
  const ticketId = ticketRow.id;

  // Find the pipeline_runs row the post-dispatch poll may have already
  // created for this run/ticket; fall back to one still missing its run id
  // (the poll raced this webhook), else create it fresh.
  let pipelineRunId: string;
  const byRunId = await supabaseAdmin
    .from("pipeline_runs")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("github_run_id", run.id)
    .maybeSingle();
  if (byRunId.data) {
    pipelineRunId = byRunId.data.id;
  } else {
    const byPendingRunId = await supabaseAdmin
      .from("pipeline_runs")
      .select("id")
      .eq("ticket_id", ticketId)
      .is("github_run_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byPendingRunId.data) {
      pipelineRunId = byPendingRunId.data.id;
    } else {
      const { data: created, error: createError } = await supabaseAdmin
        .from("pipeline_runs")
        .insert({
          ticket_id: ticketId,
          project_id: projectId,
          github_run_id: run.id,
          workflow_file: CI_WORKFLOW_FILE,
          head_branch: run.head_branch,
          status: "completed",
        })
        .select("id")
        .single();
      if (createError || !created) {
        logger.error({ err: createError, ticketId, projectId, runId: run.id }, "Could not record a pipeline run for a workflow_run webhook");
        res.status(200).json({ ignored: true });
        return;
      }
      pipelineRunId = created.id;
    }
  }

  const github = await loadGithubCreds(supabaseAdmin, projectId);
  let stages: WorkflowRunJob[] = [];
  if (github) {
    try {
      stages = await getWorkflowRunJobs(github.creds, run.id);
    } catch (err) {
      logger.error({ err, runId: run.id, projectId }, "Could not read workflow run jobs for pipeline evidence");
    }
  }

  await supabaseAdmin
    .from("pipeline_runs")
    .update({
      github_run_id: run.id,
      status: "completed",
      conclusion: run.conclusion,
      stages,
      html_url: run.html_url,
      completed_at: new Date().toISOString(),
    })
    .eq("id", pipelineRunId);

  const passed = run.conclusion === "success";
  await markTicketPipelineResult(supabaseAdmin, { projectId, ticketId, status: passed ? "passed" : "failed", runUrl: run.html_url });

  // Self-healing retry: only for a code-level failure Gemini can plausibly
  // fix (build/functional-test/integration-test). image/deploy-dev failures
  // are infra/placeholder stages Gemini has no ability to affect, and
  // feeding those back would just waste attempts. Capped at MAX_FIX_ATTEMPTS
  // total fix attempts (checked again inside fix-retry.job.ts).
  const failingStage = stages.find((s) => s.conclusion === "failure")?.name as PipelineStageName | undefined;
  const canSelfHeal = !passed && failingStage != null && RETRYABLE_STAGES.includes(failingStage) && (ticketRow.ci_fix_attempt ?? 1) < MAX_FIX_ATTEMPTS;

  if (canSelfHeal && failingStage) {
    // No comment posted here — fix-retry.job.ts posts once it has something
    // concrete to say (the regenerated commit), avoiding a
    // placeholder-then-real-comment double post.
    enqueueFixRetry({ ticketId, projectId, githubRunId: run.id, failingStage }).catch((err) => {
      logger.error({ err, ticketId, projectId, runId: run.id }, "Could not enqueue the self-healing fix-retry job");
    });
  } else {
    const retryNote = !passed
      ? failingStage != null && !RETRYABLE_STAGES.includes(failingStage)
        ? "Automatic retry is not applicable to this failure."
        : (ticketRow.ci_fix_attempt ?? 1) >= MAX_FIX_ATTEMPTS
          ? `Bankai already tried ${MAX_FIX_ATTEMPTS} automatic fix attempts — this needs a human.`
          : undefined
      : undefined;

    if (github && ticketRow.github_pr_number) {
      const comment = buildEvidenceComment({ passed, stages, runUrl: run.html_url, retryNote });
      const posted = await createPullRequestComment(github.creds, ticketRow.github_pr_number, comment);
      if (!posted.ok) {
        logger.error({ status: posted.status, message: posted.message, ticketId, projectId }, "Could not post pipeline evidence comment on PR");
      }
    }

    // Mirrors the GitHub comment block above, onto the Jira issue's own
    // conversation thread. Guarded by jira_comment_posted_at since
    // workflow_run is an at-least-once webhook (GitHub retries/redelivers),
    // and unlike the GitHub comment this one has an explicit dedup column.
    if (ticketRow.jira_issue_key) {
      const { data: runRow } = await supabaseAdmin
        .from("pipeline_runs")
        .select("jira_comment_posted_at")
        .eq("id", pipelineRunId)
        .maybeSingle();
      if (!runRow?.jira_comment_posted_at) {
        const jira = await loadJiraCreds(supabaseAdmin, projectId);
        if (jira) {
          const posted = await addPipelineEvidenceComment(jira.creds, ticketRow.jira_issue_key, {
            passed,
            stages,
            runUrl: run.html_url,
            prUrl: ticketRow.github_pr_url ?? null,
            retryNote,
          });
          if (posted.ok) {
            await supabaseAdmin
              .from("pipeline_runs")
              .update({ jira_comment_posted_at: new Date().toISOString() })
              .eq("id", pipelineRunId);
          } else {
            logger.error(
              { status: posted.status, message: posted.message, ticketId, projectId },
              "Could not post pipeline evidence comment on Jira issue",
            );
          }
        }
      }
    }
  }

  res.status(200).json({ ok: true });
}
