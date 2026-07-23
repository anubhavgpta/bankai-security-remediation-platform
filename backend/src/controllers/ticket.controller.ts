import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { getPullRequest, GithubApiError, repoFileExists } from "../lib/github.js";
import { CI_WORKFLOW_PATH } from "../lib/ci-template.js";
import { HttpError } from "../lib/http-error.js";
import {
  addIssueToSprint,
  buildFindingDescription,
  createIssue,
  getTargetSprintId,
  getIssueSnapshot,
  JiraApiError,
  transitionIssue,
} from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { enqueueFixPrResume, enqueuePipelineRetry } from "../lib/queue.js";
import { requireRole } from "../lib/roles.js";
import { computeSlaStatus, ttrStatusLabel } from "../lib/sla.js";
import { createUserScopedSupabaseClient, supabaseAdmin } from "../lib/supabase.js";
import type { Severity } from "../lib/pipeline-types.js";
import {
  closeTicketsForResolvedFindings,
  countOpenFindingsForService,
  createTicketForFinding,
  loadGithubCreds,
  loadJiraCreds,
  loadTicketFormatContext,
  markTicketPrClosedWithoutMerge,
  markTicketPrMerged,
  maybeEnqueueFixPrJob,
  reconcileJiraTickets,
  resolveRecommendations,
  SELECT_TICKET,
  toPublicTicket,
  type FindingForTicket,
  type TicketRow,
} from "../lib/ticketing.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { CreateTicketsInput, UpdateTicketInput } from "../schemas/ticket.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

async function recoverPendingCiSetup(projectId: string, tickets: TicketRow[]): Promise<void> {
  const needsBranchResume = tickets.some(
    (ticket) =>
      ticket.ci_status === "pending_setup" ||
      (!ticket.github_branch_name &&
        !ticket.github_pr_number &&
        ticket.github_pr_error === "Waiting for the Bankai CI bootstrap pull request to merge before creating a remediation branch."),
  );
  if (!needsBranchResume) return;

  try {
    const { data: project, error: projectError } = await supabaseAdmin
      .from("projects")
      .select("ci_bootstrap_status")
      .eq("id", projectId)
      .single();
    if (projectError || !project) {
      logger.error({ err: projectError, projectId }, "Could not load CI bootstrap status for pending-ticket recovery");
      return;
    }

    let bootstrapReady = project.ci_bootstrap_status === "ready";
    if (!bootstrapReady) {
      const github = await loadGithubCreds(supabaseAdmin, projectId);
      if (!github) return;

      bootstrapReady = await repoFileExists(github.creds, CI_WORKFLOW_PATH, github.defaultBranch);
      if (bootstrapReady) {
        const { error } = await supabaseAdmin.from("projects").update({ ci_bootstrap_status: "ready" }).eq("id", projectId);
        if (error) {
          logger.error({ err: error, projectId }, "Could not mark CI bootstrap ready during pending-ticket recovery");
        }
      }
    }

    if (!bootstrapReady) return;

    const { data: pending, error: pendingError } = await supabaseAdmin
      .from("tickets")
      .select("id, github_branch_name, github_pr_number, ci_status, github_pr_error")
      .eq("project_id", projectId);
    if (pendingError) {
      logger.error({ err: pendingError, projectId }, "Could not load pending CI tickets for recovery");
      return;
    }

    const resumable = (pending ?? []).filter(
      (ticket) =>
        ticket.ci_status === "pending_setup" ||
        (!ticket.github_branch_name &&
          !ticket.github_pr_number &&
          ticket.github_pr_error === "Waiting for the Bankai CI bootstrap pull request to merge before creating a remediation branch."),
    );

    for (const ticket of resumable) {
      if (ticket.github_branch_name && ticket.github_pr_number != null) {
        await enqueuePipelineRetry({ ticketId: ticket.id as string, projectId });
      } else {
        await enqueueFixPrResume({ ticketId: ticket.id as string, projectId });
      }
    }
  } catch (err) {
    logger.error({ err, projectId }, "Could not recover pending CI verification tickets");
  }
}

export async function listTickets(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  let query = supabase.from("tickets").select(SELECT_TICKET).eq("project_id", req.project!.id);

  const { service, severity, status } = req.query;
  if (typeof service === "string" && service !== "all") query = query.eq("service", service);
  if (typeof severity === "string" && severity !== "all") query = query.eq("severity", severity);
  if (typeof status === "string" && status !== "all") query = query.eq("status", status);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    throw new HttpError(500, "Could not load tickets.");
  }

  const tickets = data as TicketRow[];
  void recoverPendingCiSetup(req.project!.id, tickets);

  res.status(200).json({ tickets: tickets.map(toPublicTicket) });
}

export async function createTickets(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const { findingIds } = req.body as CreateTicketsInput;
  const supabase = userScopedClient(req);

  const { data: findings, error: findingsError } = await supabase
    .from("findings")
    .select(
      "id, fingerprint, title, service, severity, sla_due_date, external_id, rationale, cvss_score, cwe, component, file_path, finding_type, source_status, date_found, description, fix_available, source_url, environment, cves, affected_packages, current_versions, fixed_versions, recommendations, remediation_guidance, commit_sha, line_start, line_end, source, tickets ( id )",
    )
    .eq("project_id", project.id)
    .in("id", findingIds);

  if (findingsError) {
    throw new HttpError(500, "Could not load the selected findings.");
  }

  const jiraCreds = await loadJiraCreds(supabase, project.id);
  const targetSprintId = jiraCreds ? await getTargetSprintId(jiraCreds.creds, jiraCreds.projectKey) : null;
  const jira = jiraCreds ? { ...jiraCreds, targetSprintId } : null;
  const github = await loadGithubCreds(supabase, project.id);
  const formatContext = await loadTicketFormatContext(supabase, project.id);

  const created: ReturnType<typeof toPublicTicket>[] = [];
  const skipped: string[] = [];
  const actorLabel = displayNameFromUser(req.user!);

  for (const finding of findings ?? []) {
    const alreadyTicketed = Array.isArray(finding.tickets) ? finding.tickets.length > 0 : !!finding.tickets;
    if (alreadyTicketed) {
      skipped.push(finding.id);
      continue;
    }

    const { ticket } = await createTicketForFinding(supabase, {
      projectId: project.id,
      finding: finding as FindingForTicket,
      jira,
      github,
      actor: { id: req.user!.id, label: actorLabel },
      rpcName: "create_project_ticket",
      formatContext,
      slaPolicyDays: project.slaPolicyDays,
    });
    created.push(ticket);
  }

  res.status(201).json({ tickets: created, skipped });
}

// Three-way, but all of it only runs when this is called (there's no
// webhook — that would need a publicly reachable HTTPS endpoint, which a
// local dev backend doesn't have):
//  - a ticket never linked to Jira (created before Jira was connected, or
//    whose automatic sync at creation time failed) gets a fresh issue created;
//  - a ticket whose linked issue still exists gets its current Jira status
//    pulled back into Bankai;
//  - a ticket whose linked issue was deleted directly in Jira is removed
//    from Bankai entirely (not recreated) — this frees its finding to be
//    re-added from AI Triage as a brand-new ticket/issue, rather than
//    silently resurrecting one the user deliberately deleted.
// Best-effort per ticket, same as createTickets.
export async function syncTickets(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const supabase = userScopedClient(req);

  const jira = await loadJiraCreds(supabase, project.id);
  if (!jira) {
    throw new HttpError(422, "Connect Jira in Settings before syncing tickets.");
  }

  const actorLabel = displayNameFromUser(req.user!);

  // Catches tickets whose finding was resolved before this fix existed (or
  // any other drift) — same close logic a scan now runs automatically. A
  // ticket this closes will just be re-checked as a harmless no-op by the
  // per-ticket loop below (already "Done", its Jira issue already transitioned).
  const { data: resolvedFindings } = await supabase
    .from("findings")
    .select("id")
    .eq("project_id", project.id)
    .eq("bucket", "Resolved");
  await closeTicketsForResolvedFindings(supabase, {
    projectId: project.id,
    resolvedFindingIds: (resolvedFindings ?? []).map((f) => f.id),
    jira: jira.creds,
  });

  // Best-effort: catches Jira issues that already exist for findings this
  // project knows about (e.g. created by a different Bankai project/account
  // pointed at this same Jira project) but have no Bankai ticket yet, so
  // syncing repeatedly over time keeps picking up new matches as this
  // project accumulates findings — not just at initial connect time.
  const { reconciled, imported } = await reconcileJiraTickets(supabase, {
    projectId: project.id,
    jira: { creds: jira.creds, projectKey: jira.projectKey },
    actor: { id: req.user!.id, label: actorLabel },
    rpcName: "create_project_ticket",
    slaPolicyDays: project.slaPolicyDays,
  });

  const targetSprintId = await getTargetSprintId(jira.creds, jira.projectKey);
  const github = await loadGithubCreds(supabase, project.id);
  const formatContext = await loadTicketFormatContext(supabase, project.id);

  // Manual fallback for merge detection, folded into the same "Sync with
  // Jira" action rather than a separate button: if GitHub's pull_request
  // webhook can't reach this backend (most commonly local dev with no
  // publicly reachable BACKEND_PUBLIC_URL, so no webhook was ever
  // registered at all — see github.controller.ts's persistGithubConnection),
  // this polls every open-PR ticket's real GitHub state and applies the
  // same transitions the webhook would have. Skipped entirely if GitHub
  // isn't connected — this sync only ever requires Jira.
  let prMerged = 0;
  let prClosed = 0;
  if (github) {
    const { data: prRows } = await supabase
      .from("tickets")
      .select("id, github_pr_number")
      .eq("project_id", project.id)
      .not("github_pr_number", "is", null)
      .neq("status", "Done");

    for (const row of prRows ?? []) {
      if (row.github_pr_number == null) continue;
      try {
        const pr = await getPullRequest(github.creds, row.github_pr_number);
        if (!pr) continue; // PR no longer reachable — leave the ticket as-is
        if (pr.merged) {
          await markTicketPrMerged(supabase, { projectId: project.id, prNumber: row.github_pr_number });
          prMerged++;
        } else if (pr.state === "closed") {
          await markTicketPrClosedWithoutMerge(supabase, { projectId: project.id, prNumber: row.github_pr_number });
          prClosed++;
        }
      } catch (err) {
        const message = err instanceof GithubApiError ? err.message : "Could not check this ticket's pull request status.";
        logger.error({ err, message, ticketId: row.id }, "GitHub PR status sync failed for a ticket");
      }
    }
  }

  const { data: rows, error } = await supabase
    .from("tickets")
    .select(
      "id, key, title, service, severity, status, due_date, jira_issue_key, github_branch_name, finding_id, findings ( fingerprint, external_id, rationale, cvss_score, cwe, component, file_path, finding_type, source_status, date_found, description, fix_available, source_url, environment, cves, affected_packages, current_versions, fixed_versions, recommendations, remediation_guidance, commit_sha, line_start, line_end, source )",
    )
    .eq("project_id", project.id);

  if (error) {
    throw new HttpError(500, "Could not load tickets to sync.");
  }

  let synced = 0;
  let failed = 0;
  let statusPulled = 0;
  let removed = 0;

  for (const row of rows ?? []) {
    const findingRel = Array.isArray(row.findings) ? row.findings[0] : row.findings;

    if (row.jira_issue_key) {
      const snapshot = await getIssueSnapshot(jira.creds, row.jira_issue_key);
      if (snapshot.exists) {
        const statusColumns =
          snapshot.status && snapshot.status !== row.status ? { status: snapshot.status } : null;
        if (statusColumns) statusPulled++;
        if (statusColumns) {
          await supabase
            .from("tickets")
            .update(statusColumns)
            .eq("id", row.id);
        }
        if (!row.github_branch_name) {
          maybeEnqueueFixPrJob(row.id, project.id, findingRel?.source ?? null);
        }
        continue;
      }

      const { error: deleteError, count } = await supabase
        .from("tickets")
        .delete({ count: "exact" })
        .eq("id", row.id);
      if (deleteError || !count) {
        logger.error({ err: deleteError, ticketId: row.id }, "Could not remove ticket for a deleted Jira issue");
        failed++;
        continue;
      }

      removed++;
      await recordActivity(supabase, {
        projectId: project.id,
        actorId: req.user!.id,
        actorLabel,
        eventType: "ticket",
        summary: "removed",
        linkLabel: row.key,
        linkTo: "tickets",
        meta: `${row.title} · linked Jira issue ${row.jira_issue_key} was deleted`,
      });
      continue;
    }

    if (!findingRel) {
      logger.error({ ticketId: row.id, findingId: row.finding_id }, "Ticket's finding relation missing during Jira sync");
      failed++;
      continue;
    }
    const summary = `[${row.service ?? "Unassigned"}] ${row.title}`;
    const findingCount = await countOpenFindingsForService(supabase, project.id, row.service);
    const ttrStatus = ttrStatusLabel(computeSlaStatus(row.severity as Severity, row.due_date, project.slaPolicyDays));
    const description = buildFindingDescription({
      id: row.finding_id,
      fingerprint: findingRel.fingerprint,
      externalId: findingRel?.external_id ?? null,
      title: row.title,
      severity: row.severity as Severity,
      cvssScore: findingRel?.cvss_score ?? null,
      cwe: findingRel?.cwe ?? null,
      component: findingRel?.component ?? null,
      filePath: findingRel?.file_path ?? null,
      findingType: findingRel?.finding_type ?? null,
      sourceStatus: findingRel?.source_status ?? null,
      dateFound: findingRel?.date_found ?? null,
      description: findingRel?.description ?? findingRel?.rationale ?? null,
      fixAvailable: findingRel?.fix_available ?? null,
      sourceUrl: findingRel?.source_url ?? null,
      commitSha: findingRel?.commit_sha ?? null,
      lineStart: findingRel?.line_start ?? null,
      lineEnd: findingRel?.line_end ?? null,
      teamName: formatContext.teamName,
      service: row.service,
      environment: findingRel?.environment ?? null,
      findingCount,
      ttrStatus,
      cves: findingRel?.cves ?? null,
      repository: formatContext.repository,
      affectedPackages: findingRel?.affected_packages ?? null,
      currentVersions: findingRel?.current_versions ?? null,
      fixedVersions: findingRel?.fixed_versions ?? null,
      recommendations: resolveRecommendations(
        findingRel?.recommendations ?? null,
        findingRel?.remediation_guidance ?? null,
        findingRel?.fix_available ?? null,
      ),
    });

    try {
      const issue = await createIssue(jira.creds, {
        projectKey: jira.projectKey,
        title: summary,
        description,
        severity: row.severity as Severity,
        dueDate: row.due_date,
      });
      if (targetSprintId) {
        const sprintResult = await addIssueToSprint(jira.creds, targetSprintId, issue.key);
        if (!sprintResult.ok) {
          logger.error(
            { status: sprintResult.status, message: sprintResult.message, ticketId: row.id, issueKey: issue.key, sprintId: targetSprintId },
            "Jira issue was created but could not be added to the target sprint",
          );
        }
      }
      await supabase
        .from("tickets")
        .update({
          jira_issue_key: issue.key,
          jira_issue_url: issue.url,
          jira_sync_error: null,
        })
        .eq("id", row.id);
      maybeEnqueueFixPrJob(row.id, project.id, findingRel.source);
      synced++;
    } catch (err) {
      const message = err instanceof JiraApiError ? err.message : "Could not create a Jira issue for this ticket.";
      logger.error({ err, ticketId: row.id }, "Jira sync failed");
      await supabase.from("tickets").update({ jira_sync_error: message }).eq("id", row.id);
      failed++;
    }
  }

  if (synced > 0 || statusPulled > 0 || prMerged > 0 || prClosed > 0) {
    const prPart = prMerged > 0 || prClosed > 0 ? ` · ${prMerged} PR(s) merged, ${prClosed} closed without merge` : "";
    await recordActivity(supabase, {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel,
      eventType: "ticket",
      summary: "synced with Jira",
      meta: `${synced} ticket(s) created, ${statusPulled} status update(s) pulled${failed > 0 ? `, ${failed} failed` : ""}${prPart}`,
    });
  }

  res.status(200).json({ synced, failed, statusPulled, removed, reconciled, imported, prMerged, prClosed });
}

export async function updateTicket(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { status } = req.body as UpdateTicketInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("tickets")
    .update({ status })
    .eq("id", req.params.ticketId)
    .eq("project_id", req.project!.id)
    .select(SELECT_TICKET)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this ticket.");
  }
  if (!data) {
    throw new HttpError(404, "Ticket not found");
  }

  const ticketRow = data as TicketRow;

  // Best-effort — a missing/mismatched Jira transition must not fail the
  // status update in Bankai.
  if (ticketRow.jira_issue_key) {
    const jira = await loadJiraCreds(supabase, req.project!.id);
    if (jira) {
      void transitionIssue(jira.creds, ticketRow.jira_issue_key, status);
    }
  }

  res.status(200).json({ ticket: toPublicTicket(ticketRow) });
}

// Manual escape hatch for a ticket whose CI verification is stuck — e.g. it
// failed before the repo's GitHub token had the right permissions. The ticket
// list also best-effort recovers pending_setup tickets after the bootstrap
// workflow is present, but this keeps a user-controlled retry available.
export async function retryTicketPipeline(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("tickets")
    .update({ ci_status: null, ci_error: null, ci_run_url: null })
    .eq("id", req.params.ticketId)
    .eq("project_id", req.project!.id)
    .select("id, github_branch_name, github_pr_number")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not retry this ticket's verification pipeline.");
  }
  if (!data) {
    throw new HttpError(404, "Ticket not found");
  }
  if (data.github_branch_name && data.github_pr_number != null) {
    await enqueuePipelineRetry({ ticketId: data.id, projectId: req.project!.id });
  } else {
    await enqueueFixPrResume({ ticketId: data.id, projectId: req.project!.id });
  }

  res.status(202).json({ queued: true });
}

// Manual escape hatch for tickets where Bankai created the remediation branch
// but Gemini/fix generation failed before a pull request existed.
export async function retryTicketFix(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("tickets")
    .select("id, github_branch_name, github_pr_number")
    .eq("id", req.params.ticketId)
    .eq("project_id", req.project!.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not retry this ticket's fix generation.");
  }
  if (!data) {
    throw new HttpError(404, "Ticket not found");
  }
  if (!data.github_branch_name) {
    throw new HttpError(422, "This ticket does not have a remediation branch yet.");
  }
  if (data.github_pr_number != null) {
    throw new HttpError(422, "This ticket already has a pull request. Retry the CI pipeline instead.");
  }

  const { error: updateError } = await supabase
    .from("tickets")
    .update({
      status: "In Progress",
      github_pr_error: null,
      ci_status: null,
      ci_error: null,
      ci_run_url: null,
    })
    .eq("id", data.id);
  if (updateError) {
    throw new HttpError(500, "Could not retry this ticket's fix generation.");
  }

  await enqueueFixPrResume({ ticketId: data.id, projectId: req.project!.id });

  res.status(202).json({ queued: true });
}
