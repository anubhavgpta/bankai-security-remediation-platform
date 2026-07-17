import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { HttpError } from "../lib/http-error.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { Severity, TicketStatus } from "../lib/pipeline-types.js";
import { displayNameFromUser } from "../lib/user-display.js";
import type { CreateTicketsInput, UpdateTicketInput } from "../schemas/ticket.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface TicketRow {
  id: string;
  key: string;
  title: string;
  service: string | null;
  severity: Severity;
  status: TicketStatus;
  due_date: string | null;
  finding_id: string;
  created_at: string;
  // Only present when selected via SELECT_TICKET's join — absent on rows
  // returned directly from the create_project_ticket RPC.
  findings?: { external_id: string | null } | { external_id: string | null }[] | null;
}

function toPublicTicket(row: TicketRow) {
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
    createdAt: row.created_at,
  };
}

const SELECT_TICKET = "id, key, title, service, severity, status, due_date, finding_id, created_at, findings ( external_id )";

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
  const { findingIds } = req.body as CreateTicketsInput;
  const supabase = userScopedClient(req);
  const project = req.project!;

  const { data: findings, error: findingsError } = await supabase
    .from("findings")
    .select("id, title, service, severity, sla_due_date, tickets ( id )")
    .eq("project_id", project.id)
    .in("id", findingIds);

  if (findingsError) {
    throw new HttpError(500, "Could not load the selected findings.");
  }

  const created: ReturnType<typeof toPublicTicket>[] = [];
  const skipped: string[] = [];
  const actorLabel = displayNameFromUser(req.user!);

  for (const finding of findings ?? []) {
    const alreadyTicketed = Array.isArray(finding.tickets) ? finding.tickets.length > 0 : !!finding.tickets;
    if (alreadyTicketed) {
      skipped.push(finding.id);
      continue;
    }

    const { data: ticket, error: rpcError } = await supabase.rpc("create_project_ticket", {
      p_project_id: project.id,
      p_finding_id: finding.id,
      p_title: finding.title,
      p_service: finding.service,
      p_severity: finding.severity,
      p_due_date: finding.sla_due_date,
    });

    if (rpcError || !ticket) {
      throw new HttpError(500, `Could not create a ticket for "${finding.title}".`);
    }

    const publicTicket = toPublicTicket(ticket as TicketRow);
    created.push(publicTicket);

    await recordActivity(supabase, {
      projectId: project.id,
      actorId: req.user!.id,
      actorLabel,
      eventType: "ticket",
      summary: "created",
      linkLabel: publicTicket.key,
      linkTo: "tickets",
      meta: `${finding.title} · from a marked-for-Jira finding`,
    });
  }

  res.status(201).json({ tickets: created, skipped });
}

export async function updateTicket(req: Request, res: Response): Promise<void> {
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

  res.status(200).json({ ticket: toPublicTicket(data as TicketRow) });
}
