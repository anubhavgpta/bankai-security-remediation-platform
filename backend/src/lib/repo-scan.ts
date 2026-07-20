import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import {
  computeAiFingerprint,
  excludeAlreadyTicketedFindings,
  planIngest,
  type ExistingFinding,
  type NormalizedFinding,
} from "./csv-ingest.js";
import { analyzeFiles, type ScannableFile } from "./gemini.js";
import { compareCommits, getBlobs, getBranchHeadSha, getTree, type GithubCredentials } from "./github.js";
import { logger } from "./logger.js";
import { filterScannableFiles, isScannablePath } from "./repo-file-filter.js";
import type { SlaPolicyDays } from "./sla.js";
import {
  closeTicketsForResolvedFindings,
  fetchAlreadyTicketedFingerprints,
  loadJiraCreds,
  updateTicketsForChangedFindings,
} from "./ticketing.js";

// The repo-scan pipeline: fetch code -> Gemini analysis -> diff against
// existing findings -> upsert into `findings`, same as the CSV path.
// Findings just land in AI Triage for the user to review and manually
// select for ticket creation ("Mark for Jira") — no ticket/branch is
// auto-created here. Deliberately auth-context-agnostic (it takes a
// ready-made SupabaseClient) so it can run either inside an interactive
// HTTP request (M2, user-scoped client) or inside the BullMQ worker
// (M3/M4, service-role client) without duplicating this logic.
export interface RunRepoScanInput {
  supabase: SupabaseClient;
  projectId: string;
  scanId: string;
  github: { creds: GithubCredentials; defaultBranch: string };
  slaPolicyDays: SlaPolicyDays;
  defaultService: string | null;
  // Set only for a webhook-triggered push (M4): scans just the diff between
  // baseSha and headSha instead of the whole repo. Both null (or baseSha
  // omitted) means a full scan of the default branch's current HEAD.
  baseSha?: string | null;
  headSha?: string | null;
}

export interface RepoScanResult {
  commitSha: string;
  filesScanned: number;
  filesEligible: number;
  findingCount: number;
  counts: { newDelta: number; changed: number; inProgress: number; resolved: number };
}

interface FetchedFilesResult {
  commitSha: string;
  files: ScannableFile[];
  filesEligible: number;
  // Only set for an incremental scan — scopes which existing findings
  // planIngest is allowed to resolve (see below). Undefined for a full
  // scan, where every existing finding is in scope, same as the CSV path.
  touchedFilePaths?: Set<string>;
}

async function fetchFullRepo(github: RunRepoScanInput["github"]): Promise<FetchedFilesResult> {
  const commitSha = await getBranchHeadSha(github.creds, github.defaultBranch);
  const tree = await getTree(github.creds, commitSha);

  const { files: candidates, totalEligible } = filterScannableFiles(
    tree.filter((entry) => entry.type === "blob").map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 })),
    { maxFiles: env.MAX_SCAN_FILES, maxFileBytes: env.MAX_SCAN_FILE_BYTES, maxTotalBytes: env.MAX_SCAN_TOTAL_BYTES },
  );

  const files = await getBlobs(github.creds, candidates, 5);
  return { commitSha, files, filesEligible: totalEligible };
}

// Incremental: the compare API gives the changed-file list directly, so
// there's no tree walk — only added/modified/renamed files are fetched.
// touchedFilePaths includes removed and renamed-from paths too, purely so
// the caller can scope planIngest's resolve logic to what this push
// actually touched (see runRepoScan below) without re-analyzing anything.
async function fetchIncremental(
  github: RunRepoScanInput["github"],
  baseSha: string,
  headSha: string,
): Promise<FetchedFilesResult> {
  const compared = await compareCommits(github.creds, baseSha, headSha);

  const touchedFilePaths = new Set<string>();
  const toFetch: { path: string; sha: string }[] = [];

  for (const entry of compared) {
    if (entry.previousPath) touchedFilePaths.add(entry.previousPath);
    touchedFilePaths.add(entry.path);

    if (entry.status === "removed") continue;
    if (!entry.sha || !isScannablePath(entry.path)) continue;
    toFetch.push({ path: entry.path, sha: entry.sha });
  }

  const capped = toFetch.slice(0, env.MAX_SCAN_FILES);
  const fetched = await getBlobs(github.creds, capped, 5);
  // Size cap can't be checked before fetching here (the compare API doesn't
  // report blob size) — applied post-fetch instead, on however many files
  // a single push realistically touches.
  const files = fetched.filter((f) => f.content.length <= env.MAX_SCAN_FILE_BYTES);
  if (files.length < fetched.length) {
    logger.warn({ dropped: fetched.length - files.length }, "Incremental scan dropped file(s) exceeding MAX_SCAN_FILE_BYTES");
  }

  return { commitSha: headSha, files, filesEligible: toFetch.length, touchedFilePaths };
}

export async function runFullRepoScan(input: RunRepoScanInput): Promise<RepoScanResult> {
  const { supabase, projectId, scanId, github, slaPolicyDays, defaultService } = input;

  const fetched =
    input.baseSha && input.headSha
      ? await fetchIncremental(github, input.baseSha, input.headSha)
      : await fetchFullRepo(github);
  const { commitSha, files, filesEligible, touchedFilePaths } = fetched;

  if (files.length < filesEligible) {
    logger.warn(
      { projectId, scanId, scanned: files.length, eligible: filesEligible },
      "Repo scan hit its file/size caps — not all eligible files were scanned",
    );
  }

  const geminiFindings = files.length > 0 ? await analyzeFiles(files, { repo: github.creds.repo, commitSha }) : [];

  const rows: NormalizedFinding[] = geminiFindings.map((finding) => {
    const anchor = finding.lineStart
      ? `#L${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-L${finding.lineEnd}` : ""}`
      : "";
    return {
      fingerprint: computeAiFingerprint({ filePath: finding.filePath, lineStart: finding.lineStart, cwe: finding.cwe }),
      externalId: null,
      title: finding.title,
      severity: finding.severity,
      cvssScore: null,
      cwe: finding.cwe,
      component: null,
      filePath: finding.filePath,
      findingType: "AI (Gemini)",
      sourceStatus: null,
      dateFound: null,
      description: finding.evidence,
      fixAvailable: null,
      sourceUrl: `https://github.com/${github.creds.repo}/blob/${commitSha}/${finding.filePath}${anchor}`,
      service: null,
      remediationGuidance: finding.remediationGuidance,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      commitSha,
      source: "github_ai",
    };
  });

  const { data: existingRaw, error: existingError } = await supabase
    .from("findings")
    .select("fingerprint, severity, cvss_score, bucket, file_path")
    .eq("project_id", projectId);
  if (existingError) throw new Error("Could not load this project's existing findings.");

  let existing: ExistingFinding[] = (existingRaw ?? []).map((f) => ({
    fingerprint: f.fingerprint,
    severity: f.severity,
    cvssScore: f.cvss_score,
    bucket: f.bucket,
    filePath: f.file_path,
  }));

  // Incremental scans only re-analyze the files a push touched — unlike a
  // full/CSV scan, "not present in this batch" does NOT mean "resolved"
  // for a finding in a file this push never looked at. Scoping `existing`
  // to just the touched paths before handing it to planIngest keeps its
  // "not seen => resolved" logic correct: findings outside this push's
  // diff are simply never considered, so they're left exactly as they were.
  if (touchedFilePaths) {
    existing = existing.filter((f) => f.filePath && touchedFilePaths.has(f.filePath));
  }

  const rawPlan = planIngest(projectId, scanId, existing, rows, new Date(), slaPolicyDays, defaultService);

  // Loaded once, reused below for change-propagation, resolved findings, and
  // the already-ticketed-in-Jira filter just below.
  const jiraCreds = await loadJiraCreds(supabase, projectId);

  // Skip the Jira API round-trip entirely when there's nothing it could
  // filter.
  const alreadyTicketedFingerprints =
    rawPlan.counts.newDelta > 0 ? await fetchAlreadyTicketedFingerprints(jiraCreds) : new Set<string>();
  const plan = excludeAlreadyTicketedFindings(rawPlan, alreadyTicketedFingerprints);

  if (plan.upsertRows.length > 0) {
    const { data: upsertedRows, error } = await supabase
      .from("findings")
      .upsert(plan.upsertRows, { onConflict: "project_id,fingerprint" })
      .select("id");
    if (error) throw new Error("Could not save findings from this scan.");
    await updateTicketsForChangedFindings(supabase, {
      projectId,
      findingIds: (upsertedRows ?? []).map((r) => r.id),
      jira: jiraCreds?.creds ?? null,
    });
  }

  if (plan.resolvedFingerprints.length > 0) {
    const { data: resolvedRows, error } = await supabase
      .from("findings")
      .update({ bucket: "Resolved", rationale: "Not found in the latest AI scan — marked resolved." })
      .eq("project_id", projectId)
      .in("fingerprint", plan.resolvedFingerprints)
      .select("id");
    if (error) throw new Error("Could not update resolved findings.");

    await closeTicketsForResolvedFindings(supabase, {
      projectId,
      resolvedFindingIds: (resolvedRows ?? []).map((r) => r.id),
      jira: jiraCreds?.creds ?? null,
    });
  }

  return {
    commitSha,
    filesScanned: files.length,
    filesEligible,
    findingCount: rows.length,
    counts: plan.counts,
  };
}
