import type { SupabaseClient } from "@supabase/supabase-js";
import { recordActivity } from "./activity.js";
import { normalizeDate, normalizeSeverity, type FindingUpsertRow } from "./csv-ingest.js";
import { decrypt } from "./crypto.js";
import { buildBranchName, createBranch, GithubApiError, type GithubCredentials } from "./github.js";
import { HttpError } from "./http-error.js";
import {
  addBranchComment,
  addIssueToSprint,
  buildFindingDescription,
  createIssue,
  JiraApiError,
  searchIssuesInProject,
  transitionIssue,
  updateIssue,
  type JiraCredentials,
  type JiraIssueSummary,
} from "./jira.js";
import { logger } from "./logger.js";
import type { Bucket, Severity, TicketStatus } from "./pipeline-types.js";
import { computeSlaDueDate, type SlaPolicyDays } from "./sla.js";

// The per-finding "create a ticket, best-effort sync it to Jira, best-effort
// create a remediation branch" core, shared by two callers with very
// different auth contexts:
//  - ticket.controller.ts's createTickets: an interactive HTTP request, run
//    as the requesting user via a user-scoped Supabase client, gated by
//    requireRole and the create_project_ticket RPC's own project_role()
//    check.
//  - the repo-scan worker (M3): a BullMQ job with no user session, run as
//    the service-role client, calling create_project_ticket_system instead
//    (see supabase/migrations/20260718110000_add_ai_repo_scan.sql for why
//    that's a separate RPC rather than reusing create_project_ticket).
// Which RPC to call is the caller's decision (via `rpcName`), not inferred
// here, so this module never has to guess which auth context it's in.

export interface TicketRow {
  id: string;
  key: string;
  title: string;
  service: string | null;
  severity: Severity;
  status: TicketStatus;
  due_date: string | null;
  finding_id: string;
  created_at: string;
  jira_issue_key: string | null;
  jira_issue_url: string | null;
  jira_sync_error: string | null;
  github_branch_name: string | null;
  github_branch_url: string | null;
  github_branch_error: string | null;
  // Only present when selected via SELECT_TICKET's join — absent on rows
  // returned directly from the create_project_ticket* RPCs.
  findings?: { external_id: string | null } | { external_id: string | null }[] | null;
}

export function toPublicTicket(row: TicketRow) {
  const overdue = row.status !== "Done" && !!row.due_date && new Date(`${row.due_date}T00:00:00Z`) < new Date();
  const findingRel = Array.isArray(row.findings) ? row.findings[0] : row.findings;
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    service: row.service ?? "Unassigned",
    severity: row.severity,
    status: row.status,
    dueDate: row.due_date,
    overdue,
    findingId: row.finding_id,
    findingExternalId: findingRel?.external_id ?? null,
    jiraIssueKey: row.jira_issue_key ?? null,
    jiraIssueUrl: row.jira_issue_url ?? null,
    jiraSyncError: row.jira_sync_error ?? null,
    githubBranchName: row.github_branch_name ?? null,
    githubBranchUrl: row.github_branch_url ?? null,
    githubBranchError: row.github_branch_error ?? null,
    createdAt: row.created_at,
  };
}

export const SELECT_TICKET =
  "id, key, title, service, severity, status, due_date, finding_id, created_at, jira_issue_key, jira_issue_url, jira_sync_error, github_branch_name, github_branch_url, github_branch_error, findings ( external_id )";

export interface ProjectJiraRow {
  jira_site: string | null;
  jira_key: string | null;
  jira_email: string | null;
  jira_api_token_enc: string | null;
  jira_connected_at: string | null;
}

export async function loadJiraCreds(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ creds: JiraCredentials; projectKey: string } | null> {
  const { data } = await supabase
    .from("projects")
    .select("jira_site, jira_key, jira_email, jira_api_token_enc, jira_connected_at")
    .eq("id", projectId)
    .single();

  const row = data as ProjectJiraRow | null;
  if (!row?.jira_connected_at || !row.jira_site || !row.jira_key || !row.jira_email || !row.jira_api_token_enc) {
    return null;
  }

  return {
    creds: { site: row.jira_site, email: row.jira_email, apiToken: decrypt(row.jira_api_token_enc) },
    projectKey: row.jira_key,
  };
}

// Best-effort membership set for the scan-ingestion Jira dedup check (see
// excludeAlreadyTicketedFindings in csv-ingest.ts): every fingerprint that
// already has a Jira issue tracking it in the connected Jira project,
// regardless of which Bankai project/account originally created that
// issue — same cross-account reach as reconcileJiraTickets below, since
// this is a direct Jira API query, not a Bankai DB query. Never throws —
// an unreachable, rate-limited, or deauthorized Jira must not fail or
// block the surrounding scan; any failure degrades to "treat nothing as
// already-ticketed."
export async function fetchAlreadyTicketedFingerprints(
  jira: { creds: JiraCredentials; projectKey: string } | null,
): Promise<Set<string>> {
  if (!jira) return new Set();
  try {
    const issues = await searchIssuesInProject(jira.creds, jira.projectKey);
    return new Set(issues.flatMap((issue) => (issue.fingerprint ? [issue.fingerprint] : [])));
  } catch (err) {
    logger.error(
      { err, projectKey: jira.projectKey },
      "Could not check Jira for already-ticketed fingerprints during scan ingestion — proceeding without filtering",
    );
    return new Set();
  }
}

export interface ProjectGithubRow {
  github_repo: string | null;
  github_token_enc: string | null;
  github_default_branch: string | null;
  github_connected_at: string | null;
}

export async function loadGithubCreds(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ creds: GithubCredentials; defaultBranch: string } | null> {
  const { data } = await supabase
    .from("projects")
    .select("github_repo, github_token_enc, github_default_branch, github_connected_at")
    .eq("id", projectId)
    .single();

  const row = data as ProjectGithubRow | null;
  if (!row?.github_connected_at || !row.github_repo || !row.github_token_enc || !row.github_default_branch) {
    return null;
  }

  return {
    creds: { repo: row.github_repo, token: decrypt(row.github_token_enc) },
    defaultBranch: row.github_default_branch,
  };
}

// Best-effort, same contract as Jira issue creation: a remediation branch is
// a convenience, not something that should fail ticket creation/sync if
// GitHub is unreachable or misconfigured. Returns the columns to fold into
// the caller's own `tickets` update — never throws. On success, also posts a
// best-effort comment on the linked Jira issue so the branch is visible from
// Jira itself, not just Bankai.
export async function attemptBranchCreation(
  github: { creds: GithubCredentials; defaultBranch: string } | null,
  jiraCreds: JiraCredentials,
  issueKey: string,
  fingerprint: string,
  cwe: string | null,
  filePath: string | null,
  ticketId: string,
): Promise<{ github_branch_name: string | null; github_branch_url: string | null; github_branch_error: string | null } | null> {
  if (!github) return null;
  try {
    const name = buildBranchName(fingerprint, cwe, filePath);
    const branch = await createBranch(github.creds, { baseBranch: github.defaultBranch, branchName: name });

    const comment = await addBranchComment(jiraCreds, issueKey, branch);
    if (!comment.ok) {
      logger.error(
        { ticketId, issueKey, status: comment.status, message: comment.message },
        "Could not post the remediation branch link as a Jira comment",
      );
    }

    return { github_branch_name: branch.name, github_branch_url: branch.url, github_branch_error: null };
  } catch (err) {
    const message = err instanceof GithubApiError ? err.message : "Could not create a remediation branch.";
    logger.error({ err, ticketId }, "GitHub branch creation failed");
    return { github_branch_name: null, github_branch_url: null, github_branch_error: message };
  }
}

export interface FindingForTicket {
  id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  severity: Severity;
  sla_due_date: string | null;
  external_id: string | null;
  rationale: string | null;
  cvss_score: number | null;
  cwe: string | null;
  component: string | null;
  file_path: string | null;
  finding_type: string | null;
  source_status: string | null;
  date_found: string | null;
  description: string | null;
  fix_available: string | null;
  source_url: string | null;
}

export interface TicketingActor {
  id: string | null;
  label: string;
}

export interface CreateTicketForFindingInput {
  projectId: string;
  finding: FindingForTicket;
  jira: { creds: JiraCredentials; projectKey: string; activeSprintId: number | null } | null;
  github: { creds: GithubCredentials; defaultBranch: string } | null;
  actor: TicketingActor;
  // create_project_ticket (RLS/project_role()-gated, for an interactive user
  // session) or create_project_ticket_system (service-role only, for the
  // repo-scan worker) — see the migration comment above.
  rpcName: "create_project_ticket" | "create_project_ticket_system";
  activityMeta?: string;
}

// Claims a ticket key, creates the Bankai ticket, then best-effort syncs it
// to Jira and best-effort creates a remediation branch. Throws only for the
// ticket-claim step itself (a real failure to create); Jira/GitHub failures
// are captured on the ticket row instead, matching the rest of this
// codebase's "best-effort integrations" convention.
export async function createTicketForFinding(
  supabase: SupabaseClient,
  input: CreateTicketForFindingInput,
): Promise<{ ticket: ReturnType<typeof toPublicTicket> }> {
  const { projectId, finding, jira, github, actor, rpcName } = input;

  const { data: ticket, error: rpcError } = await supabase.rpc(rpcName, {
    p_project_id: projectId,
    p_finding_id: finding.id,
    p_title: finding.title,
    p_service: finding.service,
    p_severity: finding.severity,
    p_due_date: finding.sla_due_date,
  });

  if (rpcError || !ticket) {
    if (rpcError?.code === "42501") {
      throw new HttpError(403, "You do not have permission to create tickets in this project.");
    }
    if (rpcError?.code === "P0002") {
      throw new HttpError(404, "Project not found");
    }
    throw new HttpError(500, `Could not create a ticket for "${finding.title}".`);
  }

  let ticketRow = ticket as TicketRow;

  // Best-effort: a Jira outage or misconfiguration must not fail ticket
  // creation in Bankai — the internal ticket already exists either way.
  if (jira) {
    try {
      const summary = `[${finding.service ?? "Unassigned"}] ${finding.title}`;
      const description = buildFindingDescription({
        id: finding.id,
        fingerprint: finding.fingerprint,
        externalId: finding.external_id,
        title: finding.title,
        severity: finding.severity,
        cvssScore: finding.cvss_score,
        cwe: finding.cwe,
        component: finding.component,
        filePath: finding.file_path,
        findingType: finding.finding_type,
        sourceStatus: finding.source_status,
        dateFound: finding.date_found,
        description: finding.description ?? finding.rationale,
        fixAvailable: finding.fix_available,
        sourceUrl: finding.source_url,
      });

      const issue = await createIssue(jira.creds, {
        projectKey: jira.projectKey,
        title: summary,
        description,
        severity: finding.severity,
        dueDate: finding.sla_due_date,
      });
      if (jira.activeSprintId) {
        void addIssueToSprint(jira.creds, jira.activeSprintId, issue.key);
      }

      const branchColumns = await attemptBranchCreation(
        github,
        jira.creds,
        issue.key,
        finding.fingerprint,
        finding.cwe,
        finding.file_path,
        ticketRow.id,
      );

      const { data: updated } = await supabase
        .from("tickets")
        .update({
          jira_issue_key: issue.key,
          jira_issue_url: issue.url,
          jira_sync_error: null,
          ...(branchColumns ?? {}),
        })
        .eq("id", ticketRow.id)
        .select(SELECT_TICKET)
        .single();
      if (updated) ticketRow = updated as TicketRow;
    } catch (err) {
      const message = err instanceof JiraApiError ? err.message : "Could not create a Jira issue for this ticket.";
      logger.error({ err, ticketId: ticketRow.id }, "Jira issue creation failed");
      const { data: updated } = await supabase
        .from("tickets")
        .update({ jira_sync_error: message })
        .eq("id", ticketRow.id)
        .select(SELECT_TICKET)
        .single();
      if (updated) ticketRow = updated as TicketRow;
    }
  }

  const publicTicket = toPublicTicket(ticketRow);

  await recordActivity(supabase, {
    projectId,
    actorId: actor.id,
    actorLabel: actor.label,
    eventType: "ticket",
    summary: "created",
    linkLabel: publicTicket.key,
    linkTo: "tickets",
    meta: input.activityMeta ?? `${finding.title} · from a marked-for-Jira finding`,
  });

  return { ticket: publicTicket };
}

// Called wherever findings get marked Resolved (a rescan no longer detects
// them) — a resolved finding means there's no more remediation work to do,
// so any ticket still open for it should close too, in both Bankai and
// (best-effort, same contract as every other Jira call in this file) Jira.
export async function closeTicketsForResolvedFindings(
  supabase: SupabaseClient,
  input: { projectId: string; resolvedFindingIds: string[]; jira: JiraCredentials | null },
): Promise<void> {
  const { projectId, resolvedFindingIds, jira } = input;
  if (resolvedFindingIds.length === 0) return;

  const { data: closedRows, error } = await supabase
    .from("tickets")
    .update({ status: "Done" })
    .eq("project_id", projectId)
    .in("finding_id", resolvedFindingIds)
    .neq("status", "Done")
    .select("id, jira_issue_key");

  if (error) {
    logger.error({ err: error, projectId }, "Could not auto-close tickets for resolved findings");
    return;
  }

  if (jira) {
    const withJiraIssue = (closedRows ?? []).filter((t): t is { id: string; jira_issue_key: string } => !!t.jira_issue_key);
    await Promise.allSettled(withJiraIssue.map((t) => transitionIssue(jira, t.jira_issue_key, "Done")));
  }
}

export interface ReconcileJiraTicketsInput {
  projectId: string;
  jira: { creds: JiraCredentials; projectKey: string };
  actor: TicketingActor;
  // Same distinction as CreateTicketForFindingInput.rpcName — an
  // interactive request (connectJira, syncTickets) uses the RLS-gated RPC.
  rpcName: "create_project_ticket" | "create_project_ticket_system";
  // Needed to compute sla_due_date on any finding imported fresh from a
  // Jira issue (see the import pass below) — same policy planIngest uses.
  slaPolicyDays: SlaPolicyDays;
}

interface ReconcileCandidateFinding {
  id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  severity: Severity;
  sla_due_date: string | null;
  bucket: Bucket;
  tickets: { id: string }[] | { id: string } | null;
}

// Finds Jira issues in the connected Jira project that carry the portable
// "Fingerprint:" marker buildFindingDescription embeds, and either:
//  - links one to a matching finding this project already has but hasn't
//    ticketed yet (Pass 1), or
//  - imports a brand-new finding + ticket from one that matches nothing
//    this project knows about at all (Pass 2) — e.g. an issue created by a
//    different Bankai project/account pointed at the same Jira project.
// Either way, RLS/ownership stay untouched: each project only ever writes
// its own findings/tickets, and tickets.finding_id stays NOT NULL/unique —
// Pass 2 always inserts the finding before claiming a ticket for it, same
// contract as every other ticket-creation path in this file.
//
// Resolved findings are excluded from Pass 1 (reconciling a finding that's
// already closed would immediately need to be re-closed) but still count
// toward "already known" for Pass 2, so a resolved finding's issue is never
// re-imported as a duplicate.
export async function reconcileJiraTickets(
  supabase: SupabaseClient,
  input: ReconcileJiraTicketsInput,
): Promise<{ reconciled: number; imported: number }> {
  const { projectId, jira, actor, rpcName, slaPolicyDays } = input;

  const { data: findings, error } = await supabase
    .from("findings")
    .select("id, fingerprint, title, service, severity, sla_due_date, bucket, tickets ( id )")
    .eq("project_id", projectId);

  if (error) {
    logger.error({ err: error, projectId }, "Could not load findings for Jira reconciliation");
    return { reconciled: 0, imported: 0 };
  }

  const allFindings = (findings ?? []) as ReconcileCandidateFinding[];
  const knownFingerprints = new Set(allFindings.map((f) => f.fingerprint));
  const candidates = allFindings.filter(
    (f) => f.bucket !== "Resolved" && (Array.isArray(f.tickets) ? f.tickets.length === 0 : !f.tickets),
  );

  const issues = await searchIssuesInProject(jira.creds, jira.projectKey);
  const issueByFingerprint = new Map<string, JiraIssueSummary>();
  // Issues come back ORDER BY created DESC — first-write-wins keeps the
  // newest matching issue if more than one somehow shares a fingerprint
  // (e.g. a manually duplicated issue).
  for (const issue of issues) {
    if (issue.fingerprint && !issueByFingerprint.has(issue.fingerprint)) {
      issueByFingerprint.set(issue.fingerprint, issue);
    }
  }
  if (issueByFingerprint.size === 0) return { reconciled: 0, imported: 0 };

  let reconciled = 0;
  for (const finding of candidates) {
    const issue = issueByFingerprint.get(finding.fingerprint);
    if (!issue) continue;

    const { data: ticket, error: rpcError } = await supabase.rpc(rpcName, {
      p_project_id: projectId,
      p_finding_id: finding.id,
      p_title: finding.title,
      p_service: finding.service,
      p_severity: finding.severity,
      p_due_date: finding.sla_due_date,
    });
    if (rpcError || !ticket) {
      logger.error({ err: rpcError, findingId: finding.id }, "Could not claim a ticket during Jira reconciliation");
      continue;
    }

    const ticketRow = ticket as TicketRow;
    const { error: linkError } = await supabase
      .from("tickets")
      .update({ jira_issue_key: issue.key, jira_issue_url: issue.url })
      .eq("id", ticketRow.id);
    if (linkError) {
      logger.error({ err: linkError, ticketId: ticketRow.id }, "Could not link reconciled ticket to its Jira issue");
      continue;
    }

    reconciled++;
    await recordActivity(supabase, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.label,
      eventType: "ticket",
      summary: "linked to existing Jira issue",
      linkLabel: ticketRow.key,
      linkTo: "tickets",
      meta: `${finding.title} · matched Jira issue ${issue.key} by fingerprint`,
    });
  }

  let imported = 0;
  const now = new Date();
  for (const [fingerprint, issue] of issueByFingerprint) {
    if (knownFingerprints.has(fingerprint)) continue;

    const severity = normalizeSeverity(issue.severity ?? undefined, issue.cvssScore ?? null);
    const dateFound = normalizeDate(issue.dateFound ?? undefined);
    const dueFrom = dateFound ? new Date(`${dateFound}T00:00:00Z`) : now;

    const row: FindingUpsertRow = {
      project_id: projectId,
      scan_id: null,
      fingerprint,
      external_id: null,
      title: issue.title || `Untitled finding imported from Jira issue ${issue.key}`,
      severity,
      cvss_score: issue.cvssScore ?? null,
      cwe: issue.cwe ?? null,
      component: issue.component ?? null,
      file_path: issue.filePath ?? null,
      finding_type: issue.findingType ?? null,
      source_status: issue.sourceStatus ?? null,
      date_found: dateFound,
      description: issue.description ?? null,
      fix_available: issue.fixAvailable ?? null,
      source_url: issue.sourceUrl ?? null,
      service: issue.service ?? null,
      bucket: "New Delta",
      confidence: 80,
      rationale: `Imported from Jira issue ${issue.key} — created by a different Bankai project sharing this Jira connection.`,
      sla_due_date: computeSlaDueDate(severity, dueFrom, slaPolicyDays),
      last_seen_at: now.toISOString(),
      remediation_guidance: null,
      line_start: null,
      line_end: null,
      commit_sha: null,
      source: "jira_import",
    };

    // Upsert (not insert) purely as a concurrency backstop against a
    // same-project race with another reconcile run — not because duplicates
    // are expected in the common case.
    const { data: newFinding, error: insertError } = await supabase
      .from("findings")
      .upsert(row, { onConflict: "project_id,fingerprint" })
      .select("id, title, service, severity, sla_due_date")
      .single();
    if (insertError || !newFinding) {
      logger.error({ err: insertError, fingerprint }, "Could not import a finding from a Jira issue during reconciliation");
      continue;
    }

    const { data: ticket, error: rpcError } = await supabase.rpc(rpcName, {
      p_project_id: projectId,
      p_finding_id: newFinding.id,
      p_title: newFinding.title,
      p_service: newFinding.service,
      p_severity: newFinding.severity,
      p_due_date: newFinding.sla_due_date,
    });
    if (rpcError || !ticket) {
      logger.error({ err: rpcError, findingId: newFinding.id }, "Could not claim a ticket for a Jira-imported finding");
      continue;
    }

    const ticketRow = ticket as TicketRow;
    const { error: linkError } = await supabase
      .from("tickets")
      .update({ jira_issue_key: issue.key, jira_issue_url: issue.url })
      .eq("id", ticketRow.id);
    if (linkError) {
      logger.error({ err: linkError, ticketId: ticketRow.id }, "Could not link an imported ticket to its Jira issue");
      continue;
    }

    imported++;
    await recordActivity(supabase, {
      projectId,
      actorId: actor.id,
      actorLabel: actor.label,
      eventType: "ticket",
      summary: "imported from Jira",
      linkLabel: ticketRow.key,
      linkTo: "tickets",
      meta: `${newFinding.title} · imported from Jira issue ${issue.key} — no matching local finding existed`,
    });
  }

  return { reconciled, imported };
}

export interface UpdateTicketsForChangedFindingsInput {
  projectId: string;
  findingIds: string[];
  jira: JiraCredentials | null;
}

interface FindingChangeSnapshot {
  id: string;
  fingerprint: string;
  title: string;
  service: string | null;
  severity: Severity;
  sla_due_date: string | null;
  external_id: string | null;
  rationale: string | null;
  cvss_score: number | null;
  cwe: string | null;
  component: string | null;
  file_path: string | null;
  finding_type: string | null;
  source_status: string | null;
  date_found: string | null;
  description: string | null;
  fix_available: string | null;
  source_url: string | null;
}

interface ChangedTicketRow {
  id: string;
  title: string;
  service: string | null;
  severity: Severity;
  due_date: string | null;
  jira_issue_key: string | null;
  findings: FindingChangeSnapshot | FindingChangeSnapshot[] | null;
}

// Called right after a scan's findings upsert (both the CSV and GitHub-AI
// paths) — for every just-upserted finding that already has a linked
// ticket, compares the finding's current mirrored fields against the
// ticket's stored copies and propagates any drift, both to Bankai's own
// ticket row and (best-effort) to the linked Jira issue. Deliberately not
// gated by the "Changed" bucket — bucket classification (planIngest() in
// csv-ingest.ts) only flags severity/CVSS drift, but title/service/due-date
// drift is just as real and just as worth pushing. tickets.finding_id is
// UNIQUE, so this is a cheap 1:1 lookup, not a search.
export async function updateTicketsForChangedFindings(
  supabase: SupabaseClient,
  input: UpdateTicketsForChangedFindingsInput,
): Promise<{ updated: number }> {
  const { projectId, findingIds, jira } = input;
  if (findingIds.length === 0) return { updated: 0 };

  const { data: rows, error } = await supabase
    .from("tickets")
    .select(
      "id, title, service, severity, due_date, jira_issue_key, finding_id, findings ( id, fingerprint, title, service, severity, sla_due_date, external_id, rationale, cvss_score, cwe, component, file_path, finding_type, source_status, date_found, description, fix_available, source_url )",
    )
    .eq("project_id", projectId)
    .in("finding_id", findingIds);

  if (error) {
    logger.error({ err: error, projectId }, "Could not load tickets to check for finding-change propagation");
    return { updated: 0 };
  }

  let updated = 0;
  for (const row of (rows ?? []) as ChangedTicketRow[]) {
    const finding = Array.isArray(row.findings) ? row.findings[0] : row.findings;
    if (!finding) continue;

    const changed =
      finding.title !== row.title ||
      finding.service !== row.service ||
      finding.severity !== row.severity ||
      finding.sla_due_date !== row.due_date;
    if (!changed) continue;

    const { error: updateError } = await supabase
      .from("tickets")
      .update({ title: finding.title, service: finding.service, severity: finding.severity, due_date: finding.sla_due_date })
      .eq("id", row.id);
    if (updateError) {
      logger.error({ err: updateError, ticketId: row.id }, "Could not propagate finding changes to ticket");
      continue;
    }
    updated++;

    if (jira && row.jira_issue_key) {
      const description = buildFindingDescription({
        id: finding.id,
        fingerprint: finding.fingerprint,
        externalId: finding.external_id,
        title: finding.title,
        severity: finding.severity,
        cvssScore: finding.cvss_score,
        cwe: finding.cwe,
        component: finding.component,
        filePath: finding.file_path,
        findingType: finding.finding_type,
        sourceStatus: finding.source_status,
        dateFound: finding.date_found,
        description: finding.description ?? finding.rationale,
        fixAvailable: finding.fix_available,
        sourceUrl: finding.source_url,
      });
      const ok = await updateIssue(jira, row.jira_issue_key, {
        title: `[${finding.service ?? "Unassigned"}] ${finding.title}`,
        description,
        severity: finding.severity,
        dueDate: finding.sla_due_date,
      });
      await supabase
        .from("tickets")
        .update({ jira_sync_error: ok ? null : "Could not update the linked Jira issue with the latest finding details." })
        .eq("id", row.id);
    }
  }

  return { updated };
}
