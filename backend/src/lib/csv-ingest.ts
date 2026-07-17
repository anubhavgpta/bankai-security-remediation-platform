import { parse } from "csv-parse/sync";
import { computeSlaDueDate } from "./sla.js";
import type { Bucket, Severity } from "./pipeline-types.js";

export class CsvIngestError extends Error {}

export interface NormalizedFinding {
  fingerprint: string;
  externalId: string | null;
  title: string;
  severity: Severity;
  cvssScore: number | null;
  cwe: string | null;
  component: string | null;
  filePath: string | null;
  findingType: string | null;
  sourceStatus: string | null;
  dateFound: string | null;
  description: string | null;
  fixAvailable: string | null;
  sourceUrl: string | null;
  service: string | null;
}

// Scanner exports don't agree on column names, so each canonical field
// accepts a handful of common aliases (matched case/whitespace-insensitively
// against the CSV's actual header row).
const HEADER_ALIASES: Record<string, string[]> = {
  externalId: ["id", "cvit_id", "finding_id"],
  title: ["title", "name", "summary", "finding"],
  severity: ["severity", "risk", "risk_level"],
  cvssScore: ["cvss_score", "cvss", "score"],
  cwe: ["cwe", "cwe_id"],
  component: ["component", "package", "asset", "host"],
  filePath: ["file_path", "path", "location"],
  findingType: ["type", "finding_type", "category"],
  sourceStatus: ["status", "state"],
  dateFound: ["date_found", "found_date", "discovered", "first_seen"],
  description: ["description", "desc", "details"],
  fixAvailable: ["fix_available", "fix", "remediation"],
  sourceUrl: ["source_url", "reference", "url", "link"],
  // No CSV in the wild is guaranteed to have this — rows without a
  // recognized service column land in "Unassigned" until reassigned.
  service: ["service", "service_tag", "service_name", "team"],
};

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "Critical",
  severe: "Critical",
  urgent: "Critical",
  high: "High",
  medium: "Medium",
  moderate: "Medium",
  normal: "Medium",
  low: "Low",
  informational: "Low",
  info: "Low",
  minor: "Low",
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

function resolveHeaderMap(sampleRow: Record<string, string>): Partial<Record<string, string>> {
  const normalizedToActual = new Map<string, string>();
  for (const actual of Object.keys(sampleRow)) {
    normalizedToActual.set(normalizeHeader(actual), actual);
  }

  const resolved: Partial<Record<string, string>> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const actual = normalizedToActual.get(alias);
      if (actual) {
        resolved[field] = actual;
        break;
      }
    }
  }
  return resolved;
}

function normalizeSeverity(raw: string | undefined, cvss: number | null): Severity {
  const key = (raw ?? "").trim().toLowerCase();
  if (SEVERITY_ALIASES[key]) return SEVERITY_ALIASES[key];

  // Falls back to deriving severity from the CVSS score using the standard
  // v3 rating bands when the severity text doesn't match a known label.
  if (cvss !== null) {
    if (cvss >= 9) return "Critical";
    if (cvss >= 7) return "High";
    if (cvss >= 4) return "Medium";
    return "Low";
  }
  return "Medium";
}

function normalizeDate(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeForFingerprint(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function computeFingerprint(row: { externalId: string | null; title: string; component: string | null; filePath: string | null }): string {
  if (row.externalId) return `id:${normalizeForFingerprint(row.externalId)}`;
  return `sig:${normalizeForFingerprint(row.title)}|${normalizeForFingerprint(row.component)}|${normalizeForFingerprint(row.filePath)}`;
}

export function parseFindingsCsv(buffer: Buffer): NormalizedFinding[] {
  let records: Record<string, string>[];
  try {
    records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch {
    throw new CsvIngestError("Could not parse this file as CSV. Check that it's comma-separated with a header row.");
  }

  if (records.length === 0) {
    throw new CsvIngestError("This CSV has no data rows.");
  }

  const headerMap = resolveHeaderMap(records[0]!);
  if (!headerMap.title) {
    throw new CsvIngestError(
      `Could not find a title column. Expected one of: ${HEADER_ALIASES.title!.join(", ")}.`,
    );
  }

  return records.map((raw, index) => {
    const get = (field: string): string | undefined => {
      const actual = headerMap[field];
      return actual ? raw[actual] : undefined;
    };

    const title = get("title")?.trim();
    if (!title) {
      throw new CsvIngestError(`Row ${index + 2} is missing a title.`);
    }

    const cvssRaw = get("cvssScore");
    const cvssParsed = cvssRaw ? Number(cvssRaw) : NaN;
    const cvssScore = Number.isFinite(cvssParsed) ? cvssParsed : null;

    const externalId = get("externalId")?.trim() || null;
    const component = get("component")?.trim() || null;
    const filePath = get("filePath")?.trim() || null;

    return {
      fingerprint: computeFingerprint({ externalId, title, component, filePath }),
      externalId,
      title,
      severity: normalizeSeverity(get("severity"), cvssScore),
      cvssScore,
      cwe: get("cwe")?.trim() || null,
      component,
      filePath,
      findingType: get("findingType")?.trim() || null,
      sourceStatus: get("sourceStatus")?.trim() || null,
      dateFound: normalizeDate(get("dateFound")),
      description: get("description")?.trim() || null,
      fixAvailable: get("fixAvailable")?.trim() || null,
      sourceUrl: get("sourceUrl")?.trim() || null,
      service: get("service")?.trim() || null,
    };
  });
}

export interface ExistingFinding {
  fingerprint: string;
  severity: Severity;
  cvssScore: number | null;
  bucket: Bucket;
}

export interface FindingUpsertRow {
  project_id: string;
  scan_id: string;
  fingerprint: string;
  external_id: string | null;
  title: string;
  severity: Severity;
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
  service: string | null;
  bucket: Bucket;
  confidence: number;
  rationale: string;
  sla_due_date: string;
  last_seen_at: string;
}

export interface IngestCounts {
  newDelta: number;
  changed: number;
  inProgress: number;
  resolved: number;
}

export interface IngestPlan {
  upsertRows: FindingUpsertRow[];
  resolvedFingerprints: string[];
  counts: IngestCounts;
}

// Rule-based stand-in for "AI confidence" — not a trained model. Weighted so
// unambiguous matches (existing fingerprint, unchanged fields) score higher
// than a brand-new, unverified row.
function computeConfidence(bucket: Bucket, row: NormalizedFinding): number {
  let score = bucket === "In Progress" ? 92 : bucket === "Changed" ? 85 : 78;
  if (row.externalId) score += 5;
  if (row.fixAvailable) score += 2;
  return Math.max(50, Math.min(99, score));
}

export function planIngest(
  projectId: string,
  scanId: string,
  existing: ExistingFinding[],
  rows: NormalizedFinding[],
  now: Date,
): IngestPlan {
  const existingByFingerprint = new Map(existing.map((f) => [f.fingerprint, f]));
  const seenFingerprints = new Set<string>();
  const upsertRows: FindingUpsertRow[] = [];
  const counts: IngestCounts = { newDelta: 0, changed: 0, inProgress: 0, resolved: 0 };

  for (const row of rows) {
    // A duplicate fingerprint within the same CSV (e.g. re-exported rows) —
    // keep the first occurrence and skip the rest rather than upserting
    // twice with two different bucket decisions.
    if (seenFingerprints.has(row.fingerprint)) continue;
    seenFingerprints.add(row.fingerprint);

    const prev = existingByFingerprint.get(row.fingerprint);
    let bucket: Bucket;
    let rationale: string;

    if (!prev) {
      bucket = "New Delta";
      rationale = "No match found in this project's existing findings — first appearance in this intake.";
      counts.newDelta++;
    } else if (prev.severity !== row.severity || prev.cvssScore !== row.cvssScore) {
      bucket = "Changed";
      rationale = `Matched an existing finding, but severity changed from ${prev.severity} to ${row.severity} since the last scan.`;
      counts.changed++;
    } else {
      bucket = "In Progress";
      rationale = "Matched an existing finding; severity and CVSS score are unchanged since the last scan.";
      counts.inProgress++;
    }

    const dueFrom = row.dateFound ? new Date(`${row.dateFound}T00:00:00Z`) : now;

    upsertRows.push({
      project_id: projectId,
      scan_id: scanId,
      fingerprint: row.fingerprint,
      external_id: row.externalId,
      title: row.title,
      severity: row.severity,
      cvss_score: row.cvssScore,
      cwe: row.cwe,
      component: row.component,
      file_path: row.filePath,
      finding_type: row.findingType,
      source_status: row.sourceStatus,
      date_found: row.dateFound,
      description: row.description,
      fix_available: row.fixAvailable,
      source_url: row.sourceUrl,
      service: row.service,
      bucket,
      confidence: computeConfidence(bucket, row),
      rationale,
      sla_due_date: computeSlaDueDate(row.severity, dueFrom),
      last_seen_at: now.toISOString(),
    });
  }

  const resolvedFingerprints = existing
    .filter((f) => !seenFingerprints.has(f.fingerprint) && f.bucket !== "Resolved")
    .map((f) => f.fingerprint);
  counts.resolved = resolvedFingerprints.length;

  return { upsertRows, resolvedFingerprints, counts };
}
