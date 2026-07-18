import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireRole } from "../lib/roles.js";
import { computeSlaStatus, type SlaPolicyDays } from "../lib/sla.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { Bucket, Severity } from "../lib/pipeline-types.js";
import type { UpdateFindingInput } from "../schemas/finding.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface FindingRow {
  id: string;
  external_id: string | null;
  title: string;
  service: string | null;
  severity: Severity;
  cvss_score: number | null;
  cwe: string | null;
  component: string | null;
  file_path: string | null;
  finding_type: string | null;
  bucket: Bucket;
  confidence: number;
  rationale: string | null;
  description: string | null;
  fix_available: string | null;
  source_url: string | null;
  date_found: string | null;
  sla_due_date: string | null;
  first_seen_at: string;
  created_at: string;
  tickets: { id: string; key: string }[] | { id: string; key: string } | null;
}

function toPublicFinding(row: FindingRow, policyDays: SlaPolicyDays) {
  const ticket = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
  const evidence = [
    row.component && `component: ${row.component}`,
    row.file_path && `path: ${row.file_path}`,
    row.cwe && `cwe: ${row.cwe}`,
    row.source_url && `reference: ${row.source_url}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    service: row.service ?? "Unassigned",
    severity: row.severity,
    cvssScore: row.cvss_score,
    sla: computeSlaStatus(row.severity, row.sla_due_date, policyDays),
    slaDueDate: row.sla_due_date,
    bucket: row.bucket,
    confidence: row.confidence,
    firstSeen: row.first_seen_at,
    dateFound: row.date_found,
    findingType: row.finding_type,
    description: row.description,
    evidence,
    rationale: row.rationale,
    fixAvailable: row.fix_available,
    sourceUrl: row.source_url,
    ticketKey: ticket?.key ?? null,
    createdAt: row.created_at,
  };
}

const SELECT_FINDING =
  "id, external_id, title, service, severity, cvss_score, cwe, component, file_path, finding_type, bucket, confidence, rationale, description, fix_available, source_url, date_found, sla_due_date, first_seen_at, created_at, tickets ( id, key )";

export async function listFindings(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  let query = supabase.from("findings").select(SELECT_FINDING).eq("project_id", req.project!.id);

  const { service, severity, bucket } = req.query;
  if (typeof service === "string" && service !== "all") query = query.eq("service", service);
  if (typeof severity === "string" && severity !== "all") query = query.eq("severity", severity);
  if (typeof bucket === "string" && bucket !== "all") query = query.eq("bucket", bucket);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    throw new HttpError(500, "Could not load findings.");
  }

  let findings = (data as unknown as FindingRow[]).map((row) => toPublicFinding(row, req.project!.slaPolicyDays));

  const { sla } = req.query;
  if (typeof sla === "string" && sla !== "all") {
    findings = findings.filter((f) => f.sla === sla);
  }

  res.status(200).json({ findings });
}

export async function updateFinding(req: Request, res: Response): Promise<void> {
  requireRole(req.project!.myRole, ["owner", "admin", "editor"]);
  const { bucket, service } = req.body as UpdateFindingInput;
  const supabase = userScopedClient(req);

  const update: Record<string, string> = {};
  if (bucket) {
    update.bucket = bucket;
    update.rationale = `Manually reassigned to ${bucket}.`;
  }
  if (service) {
    update.service = service;
  }

  const { data, error } = await supabase
    .from("findings")
    .update(update)
    .eq("id", req.params.findingId)
    .eq("project_id", req.project!.id)
    .select(SELECT_FINDING)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this finding.");
  }
  if (!data) {
    throw new HttpError(404, "Finding not found");
  }

  res.status(200).json({ finding: toPublicFinding(data as unknown as FindingRow, req.project!.slaPolicyDays) });
}
