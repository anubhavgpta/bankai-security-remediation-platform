import type { Request, Response } from "express";
import { recordActivity } from "../lib/activity.js";
import { CsvIngestError, parseFindingsCsv, planIngest, type ExistingFinding } from "../lib/csv-ingest.js";
import { HttpError } from "../lib/http-error.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import { displayNameFromUser } from "../lib/user-display.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface ScanRow {
  id: string;
  filename: string;
  file_size_bytes: number;
  row_count: number;
  service_count: number;
  new_delta_count: number;
  changed_count: number;
  in_progress_count: number;
  resolved_count: number;
  status: "Done" | "Failed";
  error_message: string | null;
  created_at: string;
}

function toPublicScan(row: ScanRow) {
  return {
    id: row.id,
    filename: row.filename,
    fileSizeBytes: row.file_size_bytes,
    rowCount: row.row_count,
    serviceCount: row.service_count,
    newDeltaCount: row.new_delta_count,
    changedCount: row.changed_count,
    inProgressCount: row.in_progress_count,
    resolvedCount: row.resolved_count,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export async function uploadScan(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin", "editor"]);
  const file = req.file;

  if (!file) {
    throw new HttpError(400, "No file uploaded.");
  }
  if (!file.originalname.toLowerCase().endsWith(".csv")) {
    throw new HttpError(400, "Only CSV files are supported.");
  }

  const supabase = userScopedClient(req);

  let rows;
  try {
    rows = parseFindingsCsv(file.buffer);
  } catch (err) {
    const message = err instanceof CsvIngestError ? err.message : "Could not parse this CSV file.";
    await supabase.from("scans").insert({
      project_id: project.id,
      uploaded_by: req.user!.id,
      filename: file.originalname,
      file_size_bytes: file.size,
      status: "Failed",
      error_message: message,
    });
    throw new HttpError(422, message);
  }

  const { data: scan, error: scanError } = await supabase
    .from("scans")
    .insert({
      project_id: project.id,
      uploaded_by: req.user!.id,
      filename: file.originalname,
      file_size_bytes: file.size,
      row_count: rows.length,
    })
    .select("id, created_at")
    .single();

  if (scanError || !scan) {
    throw new HttpError(500, "Could not record this scan.");
  }

  const { data: existingRaw, error: existingError } = await supabase
    .from("findings")
    .select("fingerprint, severity, cvss_score, bucket")
    .eq("project_id", project.id);

  if (existingError) {
    throw new HttpError(500, "Could not load this project's existing findings.");
  }

  const existing: ExistingFinding[] = (existingRaw ?? []).map((f) => ({
    fingerprint: f.fingerprint,
    severity: f.severity,
    cvssScore: f.cvss_score,
    bucket: f.bucket,
  }));

  const { data: projectServices, error: servicesError } = await supabase
    .from("project_services")
    .select("name")
    .eq("project_id", project.id);

  if (servicesError) {
    throw new HttpError(500, "Could not load this project's services.");
  }

  const defaultService = projectServices?.length === 1 ? (projectServices[0]?.name ?? null) : null;

  const plan = planIngest(project.id, scan.id, existing, rows, new Date(), project.slaPolicyDays, defaultService);

  if (plan.upsertRows.length > 0) {
    const { error: upsertError } = await supabase
      .from("findings")
      .upsert(plan.upsertRows, { onConflict: "project_id,fingerprint" });
    if (upsertError) {
      throw new HttpError(500, "Could not save findings from this scan.");
    }
  }

  if (plan.resolvedFingerprints.length > 0) {
    const { error: resolveError } = await supabase
      .from("findings")
      .update({ bucket: "Resolved", rationale: "Present in a previous scan but not found in this intake — marked resolved." })
      .eq("project_id", project.id)
      .in("fingerprint", plan.resolvedFingerprints);
    if (resolveError) {
      throw new HttpError(500, "Could not update resolved findings.");
    }
  }

  const serviceCount = new Set(plan.upsertRows.map((r) => r.service).filter((s): s is string => !!s)).size;

  const { error: finalizeError } = await supabase
    .from("scans")
    .update({
      service_count: serviceCount,
      new_delta_count: plan.counts.newDelta,
      changed_count: plan.counts.changed,
      in_progress_count: plan.counts.inProgress,
      resolved_count: plan.counts.resolved,
    })
    .eq("id", scan.id);

  if (finalizeError) {
    throw new HttpError(500, "Could not finalize this scan's summary.");
  }

  await supabase.from("projects").update({ status: "active" }).eq("id", project.id).eq("status", "not_connected");

  const actorLabel = displayNameFromUser(req.user!);
  const sizeLabel = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  await recordActivity(supabase, {
    projectId: project.id,
    actorId: req.user!.id,
    actorLabel,
    eventType: "upload",
    summary: "uploaded",
    linkLabel: file.originalname,
    linkTo: "intake",
    meta: `${sizeLabel} · ${rows.length} rows`,
  });
  await recordActivity(supabase, {
    projectId: project.id,
    actorId: null,
    actorLabel: "System",
    eventType: "triage",
    summary: "completed triage for",
    linkLabel: file.originalname,
    linkTo: "intake",
    meta: `${rows.length} findings · ${plan.counts.newDelta} new delta · ${plan.counts.inProgress} already in progress · ${plan.counts.changed} changed · ${plan.counts.resolved} resolved`,
  });

  res.status(201).json({
    scan: toPublicScan({
      id: scan.id,
      filename: file.originalname,
      file_size_bytes: file.size,
      row_count: rows.length,
      service_count: serviceCount,
      new_delta_count: plan.counts.newDelta,
      changed_count: plan.counts.changed,
      in_progress_count: plan.counts.inProgress,
      resolved_count: plan.counts.resolved,
      status: "Done",
      error_message: null,
      created_at: scan.created_at,
    }),
  });
}

export async function listScans(req: Request, res: Response): Promise<void> {
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("scans")
    .select(
      "id, filename, file_size_bytes, row_count, service_count, new_delta_count, changed_count, in_progress_count, resolved_count, status, error_message, created_at",
    )
    .eq("project_id", req.project!.id)
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load scan history.");
  }

  res.status(200).json({ scans: (data as ScanRow[]).map(toPublicScan) });
}
