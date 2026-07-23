import type { Job } from "bullmq";
import { ensureCiBootstrapReady } from "../lib/ci-bootstrap.js";
import { recordActivity } from "../lib/activity.js";
import { generateFix, type FixFindingInput } from "../lib/gemini-fix.js";
import { gatherRepoContext } from "../lib/repo-context.js";
import {
  commitFileToBranch,
  compareCommits,
  createPullRequest,
  getBranchHeadSha,
  getBlob,
  getTree,
  GithubApiError,
} from "../lib/github.js";
import { transitionIssue, type JiraCredentials } from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { enqueuePipelineVerification, type FixPrJobData } from "../lib/queue.js";
import { attemptBranchCreation, loadGithubCreds, loadJiraCreds } from "../lib/ticketing.js";
import { supabaseAdmin } from "../lib/supabase.js";

interface FixPrTicketRow {
  id: string;
  key: string;
  status: string;
  github_branch_name: string | null;
  github_pr_number: number | null;
  github_fix_commit_sha: string | null;
  jira_issue_key: string | null;
  finding_id: string;
  findings: FixPrFindingRow | FixPrFindingRow[] | null;
}

interface FixPrFindingRow {
  fingerprint: string;
  title: string;
  source: "csv" | "github_ai" | "jira_import";
  cwe: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  description: string | null;
  rationale: string | null;
  remediation_guidance: string | null;
}

const SELECT_FIX_PR_TICKET =
  "id, key, status, github_branch_name, github_pr_number, github_fix_commit_sha, jira_issue_key, finding_id, findings ( fingerprint, title, source, cwe, file_path, line_start, line_end, description, rationale, remediation_guidance )";

async function setTicketError(ticketId: string, message: string): Promise<void> {
  await supabaseAdmin.from("tickets").update({ status: "In Progress", github_pr_error: message }).eq("id", ticketId);
}

async function maybeTransitionJira(jira: { creds: JiraCredentials } | null, issueKey: string | null, status: "In Progress" | "In Review"): Promise<void> {
  if (jira && issueKey) {
    void transitionIssue(jira.creds, issueKey, status);
  }
}

// The BullMQ processor for the "fix-pr" queue: generates an AI fix for a
// ticket's finding, commits it to the ticket's already-created remediation
// branch, and opens a pull request against the project's default branch.
// Runs with no user session (service-role client), same contract as
// repo-scan.job.ts — every query is manually scoped to project_id/ticket id
// since there's no RLS safety net here.
//
// Every early-return below is a deliberate no-op, not a failure: this job
// may run more than once for the same ticket (dedup jobId is
// belt-and-suspenders, not a hard guarantee), so it re-checks the ticket's
// own state on every run instead of trusting the caller.
export async function processFixPrJob(job: Job<FixPrJobData>): Promise<void> {
  const { ticketId, projectId } = job.data;
  const supabase = supabaseAdmin;

  const { data: ticketData, error: ticketError } = await supabase
    .from("tickets")
    .select(SELECT_FIX_PR_TICKET)
    .eq("id", ticketId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (ticketError || !ticketData) {
    logger.error({ err: ticketError, ticketId, projectId }, "fix-pr job: ticket not found");
    return;
  }
  const ticket = ticketData as FixPrTicketRow;
  const finding = Array.isArray(ticket.findings) ? ticket.findings[0] : ticket.findings;

  if (ticket.status === "Done") return;
  if (ticket.github_pr_number != null) return;
  if (finding?.source === "jira_import") return;
  if (!finding || !finding.file_path) return;

  const github = await loadGithubCreds(supabase, projectId);
  if (!github) {
    // GitHub was disconnected after this job was enqueued but before the
    // worker picked it up — a real race, not a bug.
    return;
  }

  try {
    const bootstrapReady = await ensureCiBootstrapReady(supabase, projectId, github);
    if (!bootstrapReady) {
      await supabase
        .from("tickets")
        .update({
          ci_status: "pending_setup",
          ci_error: null,
          github_pr_error: "Waiting for the Bankai CI bootstrap pull request to merge before creating a remediation branch.",
        })
        .eq("id", ticketId);
      return;
    }
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not prepare the Bankai CI verification workflow.";
    logger.error({ err, ticketId, projectId }, "CI bootstrap setup failed before fix-pr branch creation");
    await supabase.from("tickets").update({ ci_status: "failed", ci_error: message }).eq("id", ticketId);
    return;
  }

  const jira = await loadJiraCreds(supabase, projectId);

  let branch = ticket.github_branch_name;
  if (!branch) {
    if (!jira || !ticket.jira_issue_key) return;

    const branchColumns = await attemptBranchCreation(
      github,
      jira.creds,
      ticket.jira_issue_key,
      finding.fingerprint,
      finding.cwe,
      finding.file_path,
      ticket.id,
      projectId,
      ticket.key,
    );
    if (!branchColumns?.github_branch_name) {
      if (branchColumns) {
        await supabase.from("tickets").update(branchColumns).eq("id", ticketId);
      }
      return;
    }
    branch = branchColumns.github_branch_name;
    await supabase
      .from("tickets")
      .update({ ...branchColumns, ci_status: null, ci_error: null, github_pr_error: null })
      .eq("id", ticketId);
  }
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
    let headSha = await getBranchHeadSha(github.creds, branch);

    // Resume path: a previous run already committed the fix but failed
    // before opening the PR — skip straight to PR creation instead of
    // generating (and committing) a second fix.
    const alreadyCommitted = ticket.github_fix_commit_sha != null && ticket.github_fix_commit_sha === headSha;

    if (!alreadyCommitted) {
      // Safety check: never overwrite work a human already pushed to this
      // branch. An empty remediation branch has zero diff against the
      // default branch; any diff here means someone (human or a previous,
      // unrelated push) already committed to it.
      const diff = await compareCommits(github.creds, github.defaultBranch, branch);
      if (diff.length > 0) {
        await setTicketError(
          ticketId,
          "This branch already has commits — skipping the automatic fix to avoid overwriting existing work.",
        );
        return;
      }

      const tree = await getTree(github.creds, branch);
      const entry = tree.find((e) => e.path === finding.file_path);
      if (!entry) {
        await setTicketError(ticketId, `"${finding.file_path}" no longer exists on this branch.`);
        return;
      }
      const fileContent = await getBlob(github.creds, entry.sha);

      const repoContext = await gatherRepoContext({
        creds: github.creds,
        ref: branch,
        targetFilePath: finding.file_path,
        vulnerableFileContent: fileContent,
      });

      const fix = await generateFix(findingInput, fileContent, undefined, repoContext.formattedPromptContext);
      if (!fix || !fix.confident || fix.fixedContent === fileContent) {
        await setTicketError(ticketId, "Could not generate a confident automatic fix for this finding.");
        return;
      }

      // filesToUpdate is model-provided and not guaranteed disjoint from the
      // main file — the main file's fixedContent always wins on a collision.
      const extraFiles = (fix.filesToUpdate ?? []).filter((f) => f.filePath !== finding.file_path);
      const filesToCommit = [{ path: finding.file_path, content: fix.fixedContent }, ...extraFiles.map((f) => ({ path: f.filePath, content: f.fixedContent }))];

      const { commitSha } = await commitFileToBranch(github.creds, {
        branch,
        baseSha: headSha,
        message: `fix: ${finding.title}\n\n${fix.summary}\n\nAutomatically generated by Bankai AI for ${finding.cwe ?? "this"} finding.`,
        files: filesToCommit,
      });

      await supabase
        .from("tickets")
        .update({ status: "In Progress", github_fix_commit_sha: commitSha, github_pr_error: null })
        .eq("id", ticketId);
      await maybeTransitionJira(jira, ticket.jira_issue_key, "In Progress");

      headSha = commitSha;
    }

    const pr = await createPullRequest(github.creds, {
      head: branch,
      base: github.defaultBranch,
      title: `Fix: ${finding.title}`,
      body: `Automatically generated fix for a Bankai finding (${finding.cwe ?? "no CWE"}) in \`${finding.file_path}\`.\n\nA human must review and merge this pull request — Bankai never merges automatically.`,
    });

    await supabase
      .from("tickets")
      .update({
        status: "In Review",
        github_pr_number: pr.number,
        github_pr_url: pr.url,
        github_pr_state: "open",
        github_pr_error: null,
      })
      .eq("id", ticketId);
    await maybeTransitionJira(jira, ticket.jira_issue_key, "In Review");

    // Best-effort, fire-and-forget — same contract as maybeEnqueueFixPrJob
    // in ticketing.ts: a queue/Redis hiccup here must not fail the PR that
    // was just successfully opened.
    enqueuePipelineVerification({ ticketId, projectId }).catch((err) => {
      logger.error({ err, ticketId, projectId }, "Could not enqueue the CI verification pipeline");
    });

    await recordActivity(supabase, {
      projectId,
      actorId: null,
      actorLabel: "Bankai AI",
      eventType: "ticket",
      summary: "opened a pull request for",
      linkTo: "tickets",
      meta: `${finding.title} · PR #${pr.number}`,
    });
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not generate and open a fix pull request.";
    logger.error({ err, ticketId, projectId }, "fix-pr job failed");
    await setTicketError(ticketId, message);
  }
}
