import { PIPELINE_STAGE_LABELS, type PipelineStageName, type Severity, type TicketStatus } from "./pipeline-types.js";

export interface JiraCredentials {
  site: string;
  email: string;
  apiToken: string;
}

export class JiraApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

function baseUrl(site: string): string {
  return `https://${site.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

function jiraFetch(creds: JiraCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl(creds.site)}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export async function verifyConnection(creds: JiraCredentials, projectKey: string): Promise<void> {
  let me: Response;
  try {
    me = await jiraFetch(creds, "/rest/api/3/myself");
  } catch {
    throw new JiraApiError("Could not reach that Jira site — check the site URL.");
  }
  if (me.status === 401) throw new JiraApiError("Invalid email or API token.", 401);
  if (!me.ok) throw new JiraApiError(`Could not reach Jira (status ${me.status}).`, me.status);

  const proj = await jiraFetch(creds, `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  if (proj.status === 404) throw new JiraApiError(`Project key "${projectKey}" was not found on this site.`, 404);
  if (!proj.ok) throw new JiraApiError(`Could not verify the project key (status ${proj.status}).`, proj.status);
}

// Jira API v3 requires the `description` field as Atlassian Document
// Format, not plain text — this wraps each non-empty line as a paragraph.
function toADF(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

// Default Jira Cloud priority scheme.
const SEVERITY_TO_PRIORITY: Record<Severity, string> = {
  Critical: "Highest",
  High: "High",
  Medium: "Medium",
  Low: "Low",
};

// Exported so callers can render an explicit "Priority: …" line in the
// description (buildFindingDescription below), not just set Jira's native
// priority field with it.
export function severityToPriority(severity: Severity): string {
  return SEVERITY_TO_PRIORITY[severity];
}

export interface FindingSummary {
  id: string;
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
  commitSha: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  // The org-facing fields below drive the standardized ticket format — see
  // buildFindingDescription. teamName/repository come from the project
  // (Settings.tsx's "Team name" field and the connected GitHub repo,
  // respectively); the rest come from the finding. findingCount/ttrStatus
  // are computed by the caller (ticketing.ts) rather than stored.
  teamName: string | null;
  service: string | null;
  environment: string | null;
  findingCount: number;
  ttrStatus: string;
  cves: string | null;
  repository: string | null;
  affectedPackages: string | null;
  currentVersions: string | null;
  fixedVersions: string | null;
  recommendations: string | null;
}

// Renders "Label: value", or null (meaning: omit this line entirely) when
// there's nothing to show — sections below drop empty lines rather than
// printing a placeholder like "—", so a ticket only ever shows fields that
// actually have data.
function line(label: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? `${label}: ${str}` : null;
}

// A stored free-text block (e.g. `cves`, `affectedPackages`) may hold
// several newline-separated items, rendered as-is so each item lands on its
// own line — or null (section omitted) when there's nothing stored.
function block(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Same as block(), but bullets each non-empty line — used for
// Recommendations specifically, which should read as an action list. Lines
// that already start with "•" (e.g. a CSV column authored with bullets
// already in it) are left alone rather than double-bulleted.
function bulletBlock(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const bulleted = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("•") ? l : `• ${l}`))
    .join("\n");
  return bulleted || null;
}

// A titled group of lines — e.g. "Technical Details\n\nTitle: …\nSeverity: …".
// Returns null (section omitted entirely) when every line in it was null,
// so a section with nothing to say doesn't leave a bare heading behind.
function section(title: string, lines: (string | null)[]): string | null {
  const body = lines.filter((l): l is string => l !== null);
  if (body.length === 0) return null;
  return [title, "", ...body].join("\n");
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 8) : null;
}

function lineRange(start: number | null, end: number | null): string | null {
  if (start === null) return null;
  return end !== null && end !== start ? `${start}–${end}` : String(start);
}

// Section headers this function can produce, in render order — also used by
// parseSectionBody (below) to know where a section's body text ends.
export const DESCRIPTION_SECTION_HEADERS = [
  "Overview",
  "CVEs",
  "Affected Packages",
  "Current Versions",
  "Fixed Versions",
  "Recommendations",
  "Technical Details",
  "Description",
  "Source",
] as const;

// Builds a self-contained issue description so the finding can be
// remediated from the Jira ticket alone, without needing to cross-reference
// Bankai. Grouped into titled sections (Overview, CVEs, Affected Packages,
// Current Versions, Fixed Versions, Recommendations, Technical Details,
// Description, Source) — each section, and each line within it, is only
// included when there's real data for it, so nothing renders as a bare "—"
// placeholder.
//
// Fingerprint (in Technical Details) is a portable identity marker: unlike
// `ID`, which is a UUID scoped to one Bankai project's `findings` table,
// `fingerprint` is content-derived (title/component/file, or
// CWE/file/line-bucket) so the *same* underlying vulnerability scanned into
// a different Bankai project pointed at this same Jira project produces the
// same value. Repo (also in Technical Details) is the originating project's
// github_repo — reconcileJiraTickets() uses it so two Bankai projects that
// share one Jira project don't cross-link issues when fingerprints collide
// (e.g. near-clone repos). Title, Severity, and Fingerprint always have a
// value, so Technical Details (and the Fingerprint line specifically) is
// never omitted. Every label here must keep its exact text —
// parseFindingFieldsFromDescription / searchIssuesInProject below parse
// them by label.
export function buildFindingDescription(f: FindingSummary): string {
  const sections = [
    section("Overview", [
      line("Team", f.teamName),
      line("Service", f.service ?? "Unassigned"),
      line("Environment", f.environment),
      line("Priority", severityToPriority(f.severity)),
      line("Finding Count", f.findingCount),
      line("TTR Status", f.ttrStatus),
      line("Repository", f.repository),
    ]),
    section("CVEs", [block(f.cves)]),
    section("Affected Packages", [block(f.affectedPackages)]),
    section("Current Versions", [block(f.currentVersions)]),
    section("Fixed Versions", [block(f.fixedVersions)]),
    section("Recommendations", [bulletBlock(f.recommendations)]),
    section("Technical Details", [
      line("Title", f.title),
      line("Severity", f.severity),
      line("CVSS Score", f.cvssScore),
      line("CWE", f.cwe),
      line("Component", f.component),
      line("Scanner", f.findingType),
      line("File", f.filePath),
      line("Status", f.sourceStatus),
      line("Date Found", f.dateFound),
      line("Fix Available", f.fixAvailable),
      line("Fingerprint", f.fingerprint),
      // Machine-parseable repo identity for reconcile (distinct from the
      // human-facing "Repository" Overview/Source lines). Omitted when the
      // project has no connected github_repo — those issues fall through
      // reconcile's legacy fingerprint-only path.
      line("Repo", f.repository),
      line("ID", f.externalId ?? f.id),
    ]),
    section("Description", [block(f.description)]),
    // Repository alone would just duplicate the Overview line for no added
    // value — only worth its own Source section alongside at least one of
    // commit/file/lines/link, the detail Overview doesn't already show.
    ...(() => {
      const detail = [
        line("Commit", shortSha(f.commitSha)),
        line("File", f.filePath),
        line("Lines", lineRange(f.lineStart, f.lineEnd)),
        line("GitHub", f.sourceUrl),
      ].filter((l): l is string => l !== null);
      return detail.length > 0 ? [section("Source", [line("Repository", f.repository), ...detail])] : [];
    })(),
  ].filter((s): s is string => s !== null);

  return sections.join("\n\n");
}

export interface CreateIssueInput {
  projectKey: string;
  title: string;
  description: string;
  severity: Severity;
  dueDate: string | null;
}

export interface CreatedIssue {
  key: string;
  url: string;
}

interface JiraBoard {
  id: number;
}

interface JiraSprint {
  id: number;
  name: string;
}

interface JiraWriteResult {
  ok: boolean;
  status?: number | undefined;
  message?: string | undefined;
}

async function readJiraError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const reason =
    (Array.isArray(body.errorMessages) ? body.errorMessages[0] : undefined) ??
    (body.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, unknown>)[0] : undefined);
  return typeof reason === "string" ? reason : fallback;
}

async function listBoardSprints(creds: JiraCredentials, boardId: number, state: "active" | "future"): Promise<JiraSprint[] | null> {
  const res = await jiraFetch(creds, `/rest/agile/1.0/board/${boardId}/sprint?state=${state}`);
  if (!res.ok) return null;
  const { values } = (await res.json()) as { values?: JiraSprint[] };
  return values ?? [];
}

async function createFutureSprint(creds: JiraCredentials, boardId: number): Promise<JiraSprint | null> {
  const res = await jiraFetch(creds, "/rest/agile/1.0/sprint", {
    method: "POST",
    body: JSON.stringify({ name: "Sprint 1", originBoardId: boardId }),
  });
  if (!res.ok) return null;
  return (await res.json()) as JiraSprint;
}

export async function createIssue(creds: JiraCredentials, input: CreateIssueInput): Promise<CreatedIssue> {
  const res = await jiraFetch(creds, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: input.projectKey },
        summary: input.title,
        issuetype: { name: "Bug" },
        description: toADF(input.description),
        priority: { name: SEVERITY_TO_PRIORITY[input.severity] },
        ...(input.dueDate ? { duedate: input.dueDate } : {}),
      },
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const reason =
      (Array.isArray(body.errorMessages) ? body.errorMessages[0] : undefined) ??
      (body.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, unknown>)[0] : undefined);
    throw new JiraApiError(typeof reason === "string" ? reason : `Jira issue creation failed (status ${res.status}).`, res.status);
  }

  const created = (await res.json()) as { key: string };
  return { key: created.key, url: `${baseUrl(creds.site)}/browse/${created.key}` };
}

// Scrum projects put newly created issues in the Backlog until something
// explicitly moves them into a sprint. Fresh Scrum projects may only have a
// future Sprint 1, or no sprint yet. Kanban projects have no sprints at all.
// Both are normal — this best-effort
// lookup finds a target sprint so callers can add new issues to it. A project
// with no board/sprint support just returns null and callers skip the move.
export async function getTargetSprintId(creds: JiraCredentials, projectKey: string): Promise<number | null> {
  try {
    const boardsRes = await jiraFetch(creds, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`);
    if (!boardsRes.ok) return null;
    const { values: boards } = (await boardsRes.json()) as { values?: JiraBoard[] };
    const board = boards?.[0];
    if (!board) return null;

    const activeSprints = await listBoardSprints(creds, board.id, "active");
    if (activeSprints === null) return null;
    if (activeSprints[0]) return activeSprints[0].id;

    const futureSprints = await listBoardSprints(creds, board.id, "future");
    if (futureSprints === null) return null;
    const sprintOne = futureSprints.find((sprint) => sprint.name.trim().toLowerCase() === "sprint 1");
    if (sprintOne) return sprintOne.id;
    if (futureSprints[0]) return futureSprints[0].id;

    const created = await createFutureSprint(creds, board.id);
    return created?.id ?? null;
  } catch {
    return null;
  }
}

// Never throws — same best-effort contract as transitionIssue.
export async function addIssueToSprint(creds: JiraCredentials, sprintId: number, issueKey: string): Promise<JiraWriteResult> {
  try {
    const res = await jiraFetch(creds, `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: "POST",
      body: JSON.stringify({ issues: [issueKey] }),
    });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      status: res.status,
      message: await readJiraError(res, `Could not add issue to sprint (status ${res.status}).`),
    };
  } catch {
    return { ok: false, message: "Could not reach Jira while adding issue to sprint." };
  }
}

export interface BranchCommentResult {
  ok: boolean;
  status?: number | undefined;
  message?: string | undefined;
}

// Never throws — same best-effort contract as addIssueToSprint. Posts a
// comment linking the remediation branch so it's visible from the Jira
// ticket itself, not just Bankai. Returns the failure reason (rather than a
// plain boolean) so callers can log why, instead of a silent no-op.
export async function addBranchComment(
  creds: JiraCredentials,
  issueKey: string,
  branch: { name: string; url: string },
): Promise<BranchCommentResult> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Remediation branch created: " },
                { type: "text", text: branch.name, marks: [{ type: "link", attrs: { href: branch.url } }] },
              ],
            },
          ],
        },
      }),
    });
    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[]; errors?: Record<string, unknown> };
    const reason =
      body.errorMessages?.[0] ?? (body.errors && typeof body.errors === "object" ? Object.values(body.errors)[0] : undefined);
    return { ok: false, status: res.status, message: typeof reason === "string" ? reason : undefined };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Never throws — same best-effort contract as addBranchComment. Posts the
// same pass/fail + per-stage verification result that's posted as a GitHub
// PR comment, but onto the Jira issue's own conversation thread, so evidence
// is visible from Jira without opening GitHub. ADF has no markdown-table
// equivalent, so stages render as a bullet list instead of a table.
export async function addPipelineEvidenceComment(
  creds: JiraCredentials,
  issueKey: string,
  input: {
    passed: boolean;
    stages: { name: string; conclusion: string | null }[];
    runUrl: string | null;
    prUrl: string | null;
    retryNote?: string | undefined;
  },
): Promise<BranchCommentResult> {
  const stageItems = input.stages.map((s) => ({
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `${PIPELINE_STAGE_LABELS[s.name as PipelineStageName] ?? s.name}: ${s.conclusion ?? "unknown"}`,
          },
        ],
      },
    ],
  }));

  const verdictText =
    (input.passed
      ? "CD Successful — all stages passed. This branch is verified and ready for human review; a human still merges it on GitHub."
      : "Verification failed — review the failing stage before merging.") + (input.retryNote ? ` ${input.retryNote}` : "");

  const linkParagraphContent: Record<string, unknown>[] = [];
  if (input.runUrl) {
    linkParagraphContent.push(
      { type: "text", text: "View full run: " },
      { type: "text", text: input.runUrl, marks: [{ type: "link", attrs: { href: input.runUrl } }] },
    );
  }
  if (input.prUrl) {
    if (linkParagraphContent.length) linkParagraphContent.push({ type: "text", text: "  ·  " });
    linkParagraphContent.push(
      { type: "text", text: "Pull request: " },
      { type: "text", text: input.prUrl, marks: [{ type: "link", attrs: { href: input.prUrl } }] },
    );
  }

  const content: Record<string, unknown>[] = [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Bankai Verification Pipeline", marks: [{ type: "strong" }] }],
    },
  ];
  if (stageItems.length) {
    content.push({ type: "bulletList", content: stageItems });
  }
  content.push({ type: "paragraph", content: [{ type: "text", text: verdictText }] });
  if (linkParagraphContent.length) {
    content.push({ type: "paragraph", content: linkParagraphContent });
  }

  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: { type: "doc", version: 1, content } }),
    });
    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[]; errors?: Record<string, unknown> };
    const reason =
      body.errorMessages?.[0] ?? (body.errors && typeof body.errors === "object" ? Object.values(body.errors)[0] : undefined);
    return { ok: false, status: res.status, message: typeof reason === "string" ? reason : undefined };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type FixRetryCommentInput =
  | { kind: "retrying"; attempt: number; maxAttempts: number; failedStage: string; reason: string; summary: string; commitUrl: string }
  | { kind: "exhausted"; failedStage: string; reason: string; summary: string | null };

// Never throws — same best-effort contract as addBranchComment/
// addPipelineEvidenceComment. Posts the self-healing retry loop's progress
// (or its terminal give-up reasoning) onto the Jira issue's own conversation
// thread, mirroring the equivalent GitHub PR comment built in fix-retry.job.ts.
export async function addFixRetryComment(
  creds: JiraCredentials,
  issueKey: string,
  input: FixRetryCommentInput,
): Promise<BranchCommentResult> {
  const headerText = input.kind === "retrying" ? `Bankai Verification Pipeline — retrying (attempt ${input.attempt} of ${input.maxAttempts})` : "Bankai Verification Pipeline — needs a human";

  const content: Record<string, unknown>[] = [
    { type: "paragraph", content: [{ type: "text", text: headerText, marks: [{ type: "strong" }] }] },
    { type: "paragraph", content: [{ type: "text", text: `${input.failedStage} failed: ${input.reason}` }] },
  ];

  if (input.kind === "retrying") {
    content.push({ type: "paragraph", content: [{ type: "text", text: `Regenerated fix: ${input.summary}` }] });
    content.push({
      type: "paragraph",
      content: [
        { type: "text", text: "Re-running verification against " },
        { type: "text", text: "this commit", marks: [{ type: "link", attrs: { href: input.commitUrl } }] },
        { type: "text", text: "..." },
      ],
    });
  } else {
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: input.summary
            ? `Bankai could not produce a further fix: ${input.summary}`
            : "Bankai could not produce a further fix. A human needs to review and edit the code directly.",
        },
      ],
    });
  }

  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: { type: "doc", version: 1, content } }),
    });
    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[]; errors?: Record<string, unknown> };
    const reason =
      body.errorMessages?.[0] ?? (body.errors && typeof body.errors === "object" ? Object.values(body.errors)[0] : undefined);
    return { ok: false, status: res.status, message: typeof reason === "string" ? reason : undefined };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Never throws — same best-effort contract as addBranchComment. A 404 counts
// as success (the issue is already gone either way), so callers cleaning up
// a batch of issues don't need to special-case ones deleted directly in Jira.
export async function deleteIssue(creds: JiraCredentials, issueKey: string): Promise<boolean> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// Best-effort target-status name candidates per Bankai ticket status —
// Jira workflows vary, so this matches by name rather than assuming ids.
const STATUS_TO_JIRA: Record<TicketStatus, string[]> = {
  "To Do": ["To Do", "Open", "Backlog"],
  "In Progress": ["In Progress"],
  "In Review": ["In Review", "Review"],
  Done: ["Done", "Closed", "Resolved"],
};

interface JiraTransition {
  id: string;
  name: string;
  to?: { name: string };
}

// Never throws — a status change in Bankai must not fail because the
// linked Jira workflow doesn't have a matching transition available.
export async function transitionIssue(creds: JiraCredentials, issueKey: string, targetStatus: TicketStatus): Promise<boolean> {
  try {
    const listRes = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    if (!listRes.ok) return false;

    const { transitions } = (await listRes.json()) as { transitions: JiraTransition[] };
    const candidates = STATUS_TO_JIRA[targetStatus];
    const match = transitions.find((t) => candidates.includes(t.to?.name ?? t.name));
    if (!match) return false;

    const doRes = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    return doRes.ok;
  } catch {
    return false;
  }
}

// Reverse of STATUS_TO_JIRA — maps a Jira status name back to the Bankai
// status it corresponds to, so a sync run can pull status changes made
// directly in Jira (not just ones Bankai pushed itself).
const JIRA_STATUS_TO_BANKAI: Record<string, TicketStatus> = Object.fromEntries(
  (Object.entries(STATUS_TO_JIRA) as [TicketStatus, string[]][]).flatMap(([bankaiStatus, jiraNames]) =>
    jiraNames.map((name) => [name.toLowerCase(), bankaiStatus]),
  ),
);

export interface IssueSnapshot {
  exists: boolean;
  // null if the issue exists but its current Jira status doesn't map to a
  // known Bankai status (an unrecognized custom workflow state).
  status: TicketStatus | null;
}

// Never throws — a stale/unreachable link must not fail the surrounding
// sync request. Only an explicit 404 counts as "deleted"; any other
// failure (network blip, auth hiccup) reports the issue as still existing
// so a sync run never mistakenly recreates a duplicate over a transient
// error.
export async function getIssueSnapshot(creds: JiraCredentials, issueKey: string): Promise<IssueSnapshot> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`);
    if (res.status === 404) return { exists: false, status: null };
    if (!res.ok) return { exists: true, status: null };

    const body = (await res.json()) as { fields?: { status?: { name?: string } } };
    const jiraStatusName = body.fields?.status?.name;
    const status = jiraStatusName ? (JIRA_STATUS_TO_BANKAI[jiraStatusName.toLowerCase()] ?? null) : null;
    return { exists: true, status };
  } catch {
    return { exists: true, status: null };
  }
}

export interface UpdateIssueInput {
  title: string;
  description: string;
  severity: Severity;
  dueDate: string | null;
}

// Never throws — same best-effort contract as transitionIssue/deleteIssue.
// PUT /rest/api/3/issue/{key} returns 204 with no body on success. Used to
// push a Bankai ticket's fields onto an already-created Jira issue when the
// underlying finding changes on a rescan (unlike createIssue, this can be
// called repeatedly against the same issue).
export async function updateIssue(creds: JiraCredentials, issueKey: string, input: UpdateIssueInput): Promise<boolean> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: JSON.stringify({
        fields: {
          summary: input.title,
          description: toADF(input.description),
          priority: { name: SEVERITY_TO_PRIORITY[input.severity] },
          duedate: input.dueDate,
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface JiraIssueSummary {
  key: string;
  url: string;
  // null if the issue's description has no parseable "Fingerprint: <value>"
  // line — e.g. a manually created issue, or one predating this feature.
  fingerprint: string | null;
  // Originating project's github_repo from the "Repo: …" Technical Details
  // line. null for legacy issues written before that marker existed —
  // reconcile keeps fingerprint-only matching for those (with a warning).
  repo: string | null;
  // The rest are only populated when `fingerprint` is non-null — parsing an
  // issue that can never be linked or imported anyway is wasted work.
  // Recovered from the issue's summary/description (the inverse of
  // buildFindingDescription's format below) so reconcileJiraTickets()
  // (ticketing.ts) can synthesize a brand-new local finding for an issue
  // that has no match in this Bankai project — e.g. one created by a
  // different Bankai project/account pointed at the same Jira project
  // (and, after Repo filtering, the same github_repo).
  title?: string | undefined;
  service?: string | null;
  severity?: Severity | null;
  cvssScore?: number | null;
  cwe?: string | null;
  component?: string | null;
  filePath?: string | null;
  findingType?: string | null;
  sourceStatus?: string | null;
  dateFound?: string | null;
  description?: string | null;
  fixAvailable?: string | null;
  sourceUrl?: string | null;
}

const FINGERPRINT_LINE = /^Fingerprint:\s*(\S+)/m;
const EM_DASH = "—"; // the "—" buildFindingDescription() writes for a missing value

// Reads one "Label: value" line out of buildFindingDescription()'s format —
// the inverse of that function. Returns null for a missing line or the
// em-dash sentinel it writes for a null field.
function parseLabelLine(text: string, label: string): string | null {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "m").exec(text);
  if (!match) return null;
  const value = match[1]!.trim();
  return value === "" || value === EM_DASH ? null : value;
}

// Description is its own section (a bare "Description" heading followed by
// body text) rather than a "Label: value" line, and its body may itself
// contain embedded newlines (each became its own ADF paragraph,
// indistinguishable from a new "line" once adfToPlainText rejoins them) —
// so this captures everything between the "Description" heading and the
// next known section heading (or end of string), rather than to end of line.
function parseSectionBody(text: string, header: string): string | null {
  const headerMatch = new RegExp(`^${header}$`, "m").exec(text);
  if (!headerMatch) return null;

  const rest = text.slice(headerMatch.index + headerMatch[0].length);
  let end = rest.length;
  for (const otherHeader of DESCRIPTION_SECTION_HEADERS) {
    if (otherHeader === header) continue;
    const otherMatch = new RegExp(`^${otherHeader}$`, "m").exec(rest);
    if (otherMatch && otherMatch.index < end) end = otherMatch.index;
  }

  const value = rest.slice(0, end).trim();
  return value === "" || value === EM_DASH ? null : value;
}

const VALID_SEVERITIES: readonly string[] = ["Critical", "High", "Medium", "Low"];

interface ParsedFindingFields {
  title: string | null;
  severity: Severity | null;
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
}

function parseFindingFieldsFromDescription(text: string): ParsedFindingFields {
  const severityRaw = parseLabelLine(text, "Severity");
  const cvssRaw = parseLabelLine(text, "CVSS Score");
  const cvssParsed = cvssRaw ? Number(cvssRaw) : NaN;

  return {
    title: parseLabelLine(text, "Title"),
    severity: severityRaw && VALID_SEVERITIES.includes(severityRaw) ? (severityRaw as Severity) : null,
    cvssScore: Number.isFinite(cvssParsed) ? cvssParsed : null,
    cwe: parseLabelLine(text, "CWE"),
    component: parseLabelLine(text, "Component"),
    filePath: parseLabelLine(text, "File"),
    findingType: parseLabelLine(text, "Scanner"),
    sourceStatus: parseLabelLine(text, "Status"),
    dateFound: parseLabelLine(text, "Date Found"),
    description: parseSectionBody(text, "Description"),
    fixAvailable: parseLabelLine(text, "Fix Available"),
    sourceUrl: parseLabelLine(text, "GitHub"),
  };
}

// Inverse of the `[${service}] ${title}` summary format written at
// ticket.controller.ts:220 / ticketing.ts:250. The literal "Unassigned"
// bracket value is a display fallback, not a real service name, so it maps
// back to null rather than polluting the project's service list.
function parseSummary(summary: string): { service: string | null; title: string } {
  const match = /^\[(.+?)\]\s*(.*)$/.exec(summary);
  if (!match) return { service: null, title: summary.trim() };
  const service = match[1]!.trim();
  return { service: service === "Unassigned" ? null : service, title: match[2]!.trim() };
}

// Best-effort ADF -> plain text, just enough to recover the "Label: value"
// lines buildFindingDescription() writes — not a general ADF renderer.
function adfToPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (Array.isArray(n.content)) {
    const inner = n.content.map(adfToPlainText).join("");
    return n.type === "paragraph" ? `${inner}\n` : inner;
  }
  return "";
}

// Lists every issue in the connected Jira project along with the
// fingerprint (if any) parsed out of its description — plus, when a
// fingerprint is present, every other finding field recoverable from the
// description/summary — so reconcileJiraTickets() (ticketing.ts) can either
// link an already-existing issue to a matching local finding, or synthesize
// a brand-new one when no local match exists. Never throws —
// returns whatever was collected before any failure (including [] if the
// very first page fails), so a search-endpoint outage degrades to "no
// reconciliation this run" rather than breaking the caller.
//
// NOTE: uses POST /rest/api/3/search/jql with cursor-based pagination
// (nextPageToken), which superseded the older startAt/total-based
// /rest/api/3/search endpoint. Verify this against a live Jira Cloud site
// before relying on it — Atlassian's search endpoint/pagination contract
// has changed over time and the exact current shape should be confirmed,
// not assumed. Written defensively (capped page count, fails closed on any
// shape mismatch) so an incorrect assumption here degrades gracefully
// rather than looping or crashing.
export async function searchIssuesInProject(creds: JiraCredentials, projectKey: string): Promise<JiraIssueSummary[]> {
  const results: JiraIssueSummary[] = [];
  let nextPageToken: string | undefined;
  const jql = `project = "${projectKey}" ORDER BY created DESC`;
  const MAX_PAGES = 50; // 50 * 100 = 5,000 issues ceiling

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await jiraFetch(creds, "/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql,
          maxResults: 100,
          fields: ["description", "summary"],
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
      });
      if (!res.ok) return results;

      const body = (await res.json()) as {
        issues?: { key: string; fields?: { description?: unknown; summary?: string } }[];
        nextPageToken?: string;
        isLast?: boolean;
      };
      for (const issue of body.issues ?? []) {
        const text = adfToPlainText(issue.fields?.description);
        const match = FINGERPRINT_LINE.exec(text);
        const fingerprint = match?.[1] ?? null;
        const url = `${baseUrl(creds.site)}/browse/${issue.key}`;
        if (!fingerprint) {
          results.push({ key: issue.key, url, fingerprint: null, repo: null });
          continue;
        }

        const fields = parseFindingFieldsFromDescription(text);
        const summary = parseSummary(issue.fields?.summary ?? "");
        results.push({
          key: issue.key,
          url,
          fingerprint,
          // "Repo:" is the machine marker (not Overview's "Repository:") —
          // parseLabelLine("Repo") won't match "Repository:" because the
          // label must be followed immediately by ":".
          repo: parseLabelLine(text, "Repo"),
          title: summary.title || fields.title || undefined,
          service: summary.service,
          severity: fields.severity,
          cvssScore: fields.cvssScore,
          cwe: fields.cwe,
          component: fields.component,
          filePath: fields.filePath,
          findingType: fields.findingType,
          sourceStatus: fields.sourceStatus,
          dateFound: fields.dateFound,
          description: fields.description,
          fixAvailable: fields.fixAvailable,
          sourceUrl: fields.sourceUrl,
        });
      }
      if (body.isLast || !body.nextPageToken) return results;
      nextPageToken = body.nextPageToken;
    }
    return results;
  } catch {
    return results;
  }
}
