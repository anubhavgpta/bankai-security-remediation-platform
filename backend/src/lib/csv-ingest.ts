import { parse } from "csv-parse/sync";
import { computeSlaDueDate, type SlaPolicyDays } from "./sla.js";
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
  // Populated only for AI-sourced findings (see lib/gemini.ts); left
  // undefined for CSV rows, so planIngest stays source-agnostic and this
  // interface stays backward compatible with the CSV path.
  remediationGuidance?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  commitSha?: string | null;
  source?: "csv" | "github_ai";
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

export function normalizeSeverity(raw: string | undefined, cvss: number | null): Severity {
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

export function normalizeDate(raw: string | undefined): string | null {
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

const AI_FINGERPRINT_LINE_BUCKET = 10;

// Analogous to computeFingerprint above, for AI-sourced findings (lib/gemini.ts).
// Unlike a CSV row's externalId, there's no stable tool-generated identity
// here — Gemini's title text is not reproducible across separate scans of
// identical code (no temperature/seed setting fully guarantees that), so
// title is deliberately excluded from identity entirely, not just unused.
// filePath + cwe (categorical, stable) + a coarse line bucket (tolerant of
// the vulnerable line drifting a few lines between scans) is what actually
// stays stable when the same scan is re-run on unchanged code. Tradeoff:
// two distinct vulnerabilities of the same CWE within ~10 lines of each
// other in the same file will collide into one fingerprint — accepted as
// rarer and less disruptive than the title-drift false-splits this replaces.
export function computeAiFingerprint(row: { filePath: string | null; lineStart: number | null; cwe: string | null }): string {
  const lineBucket = row.lineStart != null ? Math.floor(row.lineStart / AI_FINGERPRINT_LINE_BUCKET) : "";
  return `sig:${normalizeForFingerprint(row.filePath)}|${normalizeForFingerprint(row.cwe)}|${lineBucket}`;
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
  // Only needed by incremental (webhook-triggered) repo scans, which must
  // scope planIngest's "not seen in this batch => resolved" logic to just
  // the files a push actually touched — see lib/repo-scan.ts. Left
  // undefined/unused by the CSV path, which always submits the complete
  // finding set and so has no need to scope it.
  filePath?: string | null;
}

export interface FindingUpsertRow {
  project_id: string;
  // null only for findings imported straight from a Jira issue with no
  // originating Bankai scan (reconcileJiraTickets() in ticketing.ts).
  scan_id: string | null;
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
  remediation_guidance: string | null;
  line_start: number | null;
  line_end: number | null;
  commit_sha: string | null;
  source: "csv" | "github_ai" | "jira_import";
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
  policyDays: SlaPolicyDays,
  // Applied to rows whose CSV had no recognized service column. Only set
  // when the project declares exactly one service — with more than one,
  // there's no CSV data to say which one a given row belongs to, so it's
  // left null ("Unassigned") rather than guessed.
  defaultService: string | null = null,
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
      service: row.service ?? defaultService,
      bucket,
      confidence: computeConfidence(bucket, row),
      rationale,
      sla_due_date: computeSlaDueDate(row.severity, dueFrom, policyDays),
      last_seen_at: now.toISOString(),
      remediation_guidance: row.remediationGuidance ?? null,
      line_start: row.lineStart ?? null,
      line_end: row.lineEnd ?? null,
      commit_sha: row.commitSha ?? null,
      source: row.source ?? "csv",
    });
  }

  const resolvedFingerprints = existing
    .filter((f) => !seenFingerprints.has(f.fingerprint) && f.bucket !== "Resolved")
    .map((f) => f.fingerprint);
  counts.resolved = resolvedFingerprints.length;

  return { upsertRows, resolvedFingerprints, counts };
}

// Applied after planIngest, before the caller upserts plan.upsertRows —
// drops "New Delta" rows whose fingerprint already has a tracked Jira
// issue in this project's connected Jira project (see
// ticketing.ts:fetchAlreadyTicketedFingerprints), since that vulnerability
// is already tracked via the shared Jira project and doesn't need a
// second local finding/AI Triage entry. Only ever touches "New Delta"
// rows — a Changed/In Progress row already has a local finding here, so
// this must never remove it. Kept as a separate pure step (rather than a
// planIngest parameter) so planIngest itself stays Jira-agnostic,
// synchronous, and trivially testable.
export function excludeAlreadyTicketedFindings(
  plan: IngestPlan,
  alreadyTicketedFingerprints: ReadonlySet<string>,
): IngestPlan {
  if (alreadyTicketedFingerprints.size === 0) return plan;

  let skipped = 0;
  const upsertRows = plan.upsertRows.filter((row) => {
    if (row.bucket !== "New Delta" || !alreadyTicketedFingerprints.has(row.fingerprint)) return true;
    skipped++;
    return false;
  });
  if (skipped === 0) return plan;

  return {
    upsertRows,
    resolvedFingerprints: plan.resolvedFingerprints,
    counts: { ...plan.counts, newDelta: plan.counts.newDelta - skipped },
  };
}
