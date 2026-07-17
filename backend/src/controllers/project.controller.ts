import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { computeProjectStats } from "../lib/project-stats.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { CreateProjectInput } from "../schemas/project.schema.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  jira_site: string | null;
  jira_key: string | null;
  status: "not_connected" | "active";
  created_at: string;
  project_services: { name: string }[];
}

async function toPublicProject(supabase: SupabaseClient, row: ProjectRow) {
  const stats = await computeProjectStats(supabase, row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    services: row.project_services.map((s) => s.name),
    jiraSite: row.jira_site,
    jiraKey: row.jira_key,
    stats: { totalCvits: stats.totalCvits, slaBreachedPct: stats.slaBreachedPct, openTickets: stats.openTickets },
    lastIntakeAt: stats.lastIntakeAt,
    createdAt: row.created_at,
  };
}

function userScopedClient(req: Request) {
  // requireAuth guarantees req.accessToken is set before any handler here runs.
  return createUserScopedSupabaseClient(req.accessToken as string);
}

// Ticket keys look like "<prefix>-101" (e.g. an "Acquisitions Audit" project
// gets "AA"). Multi-word names use initials; single-word names use the first
// three letters. Falls back to "PRJ" for names with no letters at all.
function deriveKeyPrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words
          .slice(0, 4)
          .map((w) => w[0])
          .join("")
      : (words[0] ?? "").slice(0, 3);

  const prefix = letters.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return prefix || "PRJ";
}

export async function listProjects(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, description, jira_site, jira_key, status, created_at, project_services ( name )")
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load projects.");
  }

  const projects = await Promise.all((data as ProjectRow[]).map((row) => toPublicProject(supabase, row)));
  res.status(200).json({ projects });
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, description, jira_site, jira_key, status, created_at, project_services ( name )")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not load project.");
  }
  if (!data) {
    throw new HttpError(404, "Project not found");
  }

  res.status(200).json({ project: await toPublicProject(supabase, data as ProjectRow) });
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const { name, description, services, jiraSite, jiraKey } = req.body as CreateProjectInput;
  const supabase = userScopedClient(req);

  const { data: project, error: insertError } = await supabase
    .from("projects")
    .insert({
      owner_id: req.user!.id,
      name,
      description: description || null,
      jira_site: jiraSite || null,
      jira_key: jiraKey || null,
      key_prefix: deriveKeyPrefix(name),
    })
    .select("id, name, description, jira_site, jira_key, status, created_at")
    .single();

  if (insertError || !project) {
    throw new HttpError(500, "Could not create project.");
  }

  let serviceNames: string[] = [];
  if (services.length > 0) {
    const { data: insertedServices, error: servicesError } = await supabase
      .from("project_services")
      .insert(services.map((serviceName) => ({ project_id: project.id, name: serviceName })))
      .select("name");

    if (servicesError) {
      throw new HttpError(500, "Project created, but services could not be saved.");
    }
    serviceNames = (insertedServices ?? []).map((s) => s.name);
  }

  res.status(201).json({
    project: await toPublicProject(supabase, { ...project, project_services: serviceNames.map((n) => ({ name: n })) }),
  });
}
