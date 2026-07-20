import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { HttpError } from "../lib/http-error.js";
import {
  addIssueToSprint,
  buildFindingDescription,
  createIssue,
  getActiveSprintId,
  getIssueSnapshot,
  JiraApiError,
  transitionIssue,
} from "../lib/jira.js";
import { logger } from "../lib/logger.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { Severity } from "../lib/pipeline-types.js";
import {
  attemptBranchCreation,
  closeTicketsForResolvedFindings,
  createTicketForFinding,
  loadGithubCreds,
  loadJiraCreds,
  reconcileJiraTickets,
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

  res.status(200).json({ tickets: (data as TicketRow[]).map(toPublicTicket) });
}

export async function createTickets(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const { findingIds } = req.body as CreateTicketsInput;
  const supabase = userScopedClient(req);

  const { data: findings, error: findingsError } = await supabase
    .from("findings")
    .select(
      "id, fingerprint, title, service, severity, sla_due_date, external_id, rationale, cvss_score, cwe, component, file_path, finding_type, source_status, date_found, description, fix_available, source_url, tickets ( id )",
    )
    .eq("project_id", project.id)
    .in("id", findingIds);

  if (findingsError) {
    throw new HttpError(500, "Could not load the selected findings.");
  }

  const jiraCreds = await loadJiraCreds(supabase, project.id);
  const activeSprintId = jiraCreds ? await getActiveSprintId(jiraCreds.creds, jiraCreds.projectKey) : null;
  const jira = jiraCreds ? { ...jiraCreds, activeSprintId } : null;
  const github = await loadGithubCreds(supabase, project.id);

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

  const activeSprintId = await getActiveSprintId(jira.creds, jira.projectKey);
  const github = await loadGithubCreds(supabase, project.id);

  const { data: rows, error } = await supabase
    .from("tickets")
    .select(
      "id, key, title, service, severity, status, due_date, jira_issue_key, github_branch_name, finding_id, findings ( fingerprint, external_id, rationale, cvss_score, cwe, component, file_path, finding_type, source_status, date_found, description, fix_available, source_url )",
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
        const branchColumns =
          !row.github_branch_name && findingRel
            ? await attemptBranchCreation(
                github,
                jira.creds,
                row.jira_issue_key,
                findingRel.fingerprint,
                findingRel.cwe,
                findingRel.file_path,
                row.id,
              )
            : null;
        if (statusColumns) statusPulled++;
        if (statusColumns || branchColumns) {
          await supabase
            .from("tickets")
            .update({ ...statusColumns, ...branchColumns })
            .eq("id", row.id);
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
    });

    try {
      const issue = await createIssue(jira.creds, {
        projectKey: jira.projectKey,
        title: summary,
        description,
        severity: row.severity as Severity,
        dueDate: row.due_date,
      });
      if (activeSprintId) {
        void addIssueToSprint(jira.creds, activeSprintId, issue.key);
      }
      const branchColumns = await attemptBranchCreation(
        github,
        jira.creds,
        issue.key,
        findingRel.fingerprint,
        findingRel.cwe,
        findingRel.file_path,
        row.id,
      );
      await supabase
        .from("tickets")
        .update({
          jira_issue_key: issue.key,
          jira_issue_url: issue.url,
          jira_sync_error: null,
          ...(branchColumns ?? {}),
        })
        .eq("id", row.id);
      synced++;
    } catch (err) {
      const message = err instanceof JiraApiError ? err.message : "Could not create a Jira issue for this ticket.";
      logger.error({ err, ticketId: row.id }, "Jira sync failed");
      await supabase.from("tickets").update({ jira_sync_error: message }).eq("id", row.id);
      failed++;
    }
  }

  if (synced > 0 || statusPulled > 0) {
    await recordActivity(supabase, {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel,
      eventType: "ticket",
      summary: "synced with Jira",
      meta: `${synced} ticket(s) created, ${statusPulled} status update(s) pulled${failed > 0 ? `, ${failed} failed` : ""}`,
    });
  }

  res.status(200).json({ synced, failed, statusPulled, removed, reconciled, imported });
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
