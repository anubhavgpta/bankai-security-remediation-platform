const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors?: Array<{ path: string; message: string }>;

  constructor(status: number, message: string, fieldErrors?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  // FormData bodies (file uploads) must NOT get an explicit Content-Type —
  // the browser sets one with the multipart boundary itself.
  const isFormData = options.body instanceof FormData;

  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? "Something went wrong. Please try again.", body.details);
  }

  return body as T;
}

export interface PublicUser {
  id: string;
  email: string | null;
  fullName: string | null;
  // False for accounts created via Google/GitHub SSO that never set a
  // Bankai password — gates whether password-based UI (change password,
  // the delete-account password confirmation) should even be shown.
  hasPassword: boolean;
}

export type SignupResult =
  | { status: "confirmation_required"; message: string }
  | { status: "signed_in"; user: PublicUser };

export function signup(input: { fullName: string; email: string; password: string }): Promise<SignupResult> {
  return apiFetch("/auth/signup", { method: "POST", body: JSON.stringify(input) });
}

export function login(input: { email: string; password: string }): Promise<{ status: "signed_in"; user: PublicUser }> {
  return apiFetch("/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export function logout(): Promise<void> {
  return apiFetch("/auth/logout", { method: "POST" });
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  return apiFetch("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
}

export type ResetPasswordResult =
  | { status: "signed_in"; user: PublicUser }
  | { status: "password_reset" };

export function resetPassword(input: { accessToken: string; newPassword: string }): Promise<ResetPasswordResult> {
  return apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify(input) });
}

// A real browser navigation (the provider's consent screen redirects the
// whole page), not a fetch — callers should do
// `window.location.href = ssoAuthorizeUrl('google')`. Works for both
// login and signup: Supabase creates the account on first use.
export function ssoAuthorizeUrl(provider: 'google' | 'github'): string {
  return `${API_BASE_URL}/api/auth/sso/${provider}`;
}

export function getSession(): Promise<{ user: PublicUser }> {
  return apiFetch("/auth/session", { method: "GET" });
}

export function updateProfile(input: { fullName: string }): Promise<{ user: PublicUser }> {
  return apiFetch("/auth/profile", { method: "PATCH", body: JSON.stringify(input) });
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return apiFetch("/auth/password", { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteAccount(password?: string): Promise<void> {
  return apiFetch("/auth/account", { method: "DELETE", body: JSON.stringify({ password }) });
}

export interface ProjectStats {
  totalCvits: number;
  slaBreachedPct: number;
  openTickets: number;
}

export interface SlaPolicyDays {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export type ProjectRole = "owner" | "admin" | "editor" | "viewer";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  teamName: string | null;
  status: "not_connected" | "active";
  services: string[];
  jiraSite: string | null;
  jiraKey: string | null;
  jiraConnected: boolean;
  slaPolicyDays: SlaPolicyDays;
  myRole: ProjectRole;
  stats: ProjectStats;
  lastIntakeAt: string | null;
  createdAt: string;
}

export function listProjects(): Promise<{ projects: Project[] }> {
  return apiFetch("/projects", { method: "GET" });
}

export function getProject(id: string): Promise<{ project: Project }> {
  return apiFetch(`/projects/${id}`, { method: "GET" });
}

export function createProject(input: {
  name: string;
  description?: string;
  teamName?: string;
  services?: string[];
}): Promise<{ project: Project }> {
  return apiFetch("/projects", { method: "POST", body: JSON.stringify(input) });
}

export function deleteProject(id: string, confirmName: string): Promise<void> {
  return apiFetch(`/projects/${id}`, { method: "DELETE", body: JSON.stringify({ confirmName }) });
}

export function updateProjectSettings(projectId: string, input: { teamName: string }): Promise<{ teamName: string | null }> {
  return apiFetch(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------
// Jira connection
// ---------------------------------------------------------------------

export interface JiraConnection {
  connected: boolean;
  site: string | null;
  projectKey: string | null;
  email: string | null;
  connectedAt: string | null;
}

export function getJiraConnection(projectId: string): Promise<JiraConnection> {
  return apiFetch(`/projects/${projectId}/jira`, { method: "GET" });
}

export function connectJira(
  projectId: string,
  input: { site: string; email: string; apiToken: string; projectKey: string },
): Promise<JiraConnection & { reconciled: number; imported: number }> {
  return apiFetch(`/projects/${projectId}/jira/connect`, { method: "POST", body: JSON.stringify(input) });
}

export function disconnectJira(projectId: string): Promise<JiraConnection> {
  return apiFetch(`/projects/${projectId}/jira/disconnect`, { method: "POST" });
}

// ---------------------------------------------------------------------
// GitHub connection
// ---------------------------------------------------------------------

export interface GithubConnection {
  connected: boolean;
  repo: string | null;
  defaultBranch: string | null;
  connectedAt: string | null;
  webhookRegistered: boolean;
  webhookUrl: string | null;
  // Only ever present in the response right after connectGithub() — shown
  // once, like the PAT itself, when auto-registration wasn't possible and
  // the user needs to paste it into GitHub's "Add webhook" form manually.
  webhookSecret?: string;
}

export function getGithubConnection(projectId: string): Promise<GithubConnection> {
  return apiFetch(`/projects/${projectId}/github`, { method: "GET" });
}

export function connectGithub(
  projectId: string,
  input: { repo: string; token: string; baseBranch?: string },
): Promise<GithubConnection> {
  return apiFetch(`/projects/${projectId}/github/connect`, { method: "POST", body: JSON.stringify(input) });
}

export function disconnectGithub(projectId: string): Promise<GithubConnection> {
  return apiFetch(`/projects/${projectId}/github/disconnect`, { method: "POST" });
}

export function scanGithubRepo(projectId: string): Promise<{ scan: Scan }> {
  return apiFetch(`/projects/${projectId}/github/scan`, { method: "POST" });
}

export function connectGithubFromAccount(
  projectId: string,
  input: { repo: string; baseBranch?: string },
): Promise<GithubConnection> {
  return apiFetch(`/projects/${projectId}/github/connect-account`, { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------
// GitHub account connection (per-user OAuth grant, reused by the repo
// picker across every project) — distinct from the per-project connection
// above, which stays available as a manual PAT fallback.
// ---------------------------------------------------------------------

export interface GithubAccountStatus {
  connected: boolean;
  login: string | null;
}

export function getGithubAccountStatus(): Promise<GithubAccountStatus> {
  return apiFetch("/auth/github/status", { method: "GET" });
}

export function disconnectGithubAccount(): Promise<GithubAccountStatus> {
  return apiFetch("/auth/github/disconnect", { method: "POST" });
}

export interface GithubUserRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

export function listMyGithubRepos(): Promise<{ repos: GithubUserRepo[] }> {
  return apiFetch("/auth/github/repos", { method: "GET" });
}

// A real browser navigation (GitHub's OAuth flow redirects the whole page),
// not a fetch — callers should do `window.location.href = githubAuthorizeUrl()`.
export function githubAuthorizeUrl(): string {
  return `${API_BASE_URL}/api/auth/github/authorize`;
}

// ---------------------------------------------------------------------
// SLA policy
// ---------------------------------------------------------------------

export function updateSlaPolicy(projectId: string, input: SlaPolicyDays): Promise<SlaPolicyDays> {
  return apiFetch(`/projects/${projectId}/sla`, { method: "PATCH", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------
// Scans (Report Intake)
// ---------------------------------------------------------------------

export interface Scan {
  id: string;
  filename: string | null;
  fileSizeBytes: number;
  rowCount: number;
  serviceCount: number;
  newDeltaCount: number;
  changedCount: number;
  inProgressCount: number;
  resolvedCount: number;
  status: "Queued" | "Processing" | "Done" | "Failed";
  errorMessage: string | null;
  source: "csv" | "github_ai";
  triggerType: "manual" | "webhook" | null;
  commitSha: string | null;
  baseCommitSha: string | null;
  branch: string | null;
  findingCount: number | null;
  createdAt: string;
}

export function listScans(projectId: string): Promise<{ scans: Scan[] }> {
  return apiFetch(`/projects/${projectId}/scans`, { method: "GET" });
}

export function getScan(projectId: string, scanId: string): Promise<{ scan: Scan }> {
  return apiFetch(`/projects/${projectId}/scans/${scanId}`, { method: "GET" });
}

export function uploadScan(projectId: string, file: File): Promise<{ scan: Scan }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch(`/projects/${projectId}/scans`, { method: "POST", body: formData });
}

// ---------------------------------------------------------------------
// Findings (AI Triage)
// ---------------------------------------------------------------------

export type Severity = "Critical" | "High" | "Medium" | "Low";
export type Bucket = "New Delta" | "In Progress" | "Changed" | "Resolved";
export type SlaStatus = "Missed" | "Approaching" | "On track";
export type TicketStatus = "To Do" | "In Progress" | "In Review" | "Done";

export interface Finding {
  id: string;
  externalId: string | null;
  title: string;
  service: string;
  severity: Severity;
  cvssScore: number | null;
  sla: SlaStatus;
  slaDueDate: string | null;
  bucket: Bucket;
  confidence: number;
  firstSeen: string;
  dateFound: string | null;
  findingType: string | null;
  description: string | null;
  evidence: string;
  rationale: string | null;
  fixAvailable: string | null;
  sourceUrl: string | null;
  ticketId: string | null;
  ticketKey: string | null;
  ticketStatus: TicketStatus | null;
  createdAt: string;
  source: "csv" | "github_ai" | "jira_import";
  remediationGuidance: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  commitSha: string | null;
}

export interface FindingFilters {
  service?: string;
  severity?: string;
  sla?: string;
  bucket?: string;
  [key: string]: string | undefined;
}

function toQueryString<T extends Record<string, string | undefined>>(filters: T): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && value !== "all") params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function listFindings(projectId: string, filters: FindingFilters = {}): Promise<{ findings: Finding[] }> {
  return apiFetch(`/projects/${projectId}/findings${toQueryString(filters)}`, { method: "GET" });
}

export function reassignFindingBucket(projectId: string, findingId: string, bucket: Bucket): Promise<{ finding: Finding }> {
  return apiFetch(`/projects/${projectId}/findings/${findingId}`, { method: "PATCH", body: JSON.stringify({ bucket }) });
}

export function reassignFindingService(projectId: string, findingId: string, service: string): Promise<{ finding: Finding }> {
  return apiFetch(`/projects/${projectId}/findings/${findingId}`, { method: "PATCH", body: JSON.stringify({ service }) });
}

// ---------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------

export interface Ticket {
  id: string;
  key: string;
  title: string;
  service: string;
  severity: Severity;
  status: TicketStatus;
  dueDate: string | null;
  overdue: boolean;
  findingId: string;
  findingExternalId: string | null;
  jiraIssueKey: string | null;
  jiraIssueUrl: string | null;
  jiraSyncError: string | null;
  githubBranchName: string | null;
  githubBranchUrl: string | null;
  githubBranchError: string | null;
  githubPrNumber: number | null;
  githubPrUrl: string | null;
  githubPrState: "open" | "merged" | "closed" | null;
  githubPrError: string | null;
  githubPrLowConfidence: boolean;
  ciStatus: "pending_setup" | "queued" | "running" | "passed" | "failed" | null;
  ciRunUrl: string | null;
  ciError: string | null;
  createdAt: string;
}

export interface TicketFilters {
  service?: string;
  severity?: string;
  status?: string;
  [key: string]: string | undefined;
}

export function listTickets(projectId: string, filters: TicketFilters = {}): Promise<{ tickets: Ticket[] }> {
  return apiFetch(`/projects/${projectId}/tickets${toQueryString(filters)}`, { method: "GET" });
}

export function createTickets(projectId: string, findingIds: string[]): Promise<{ tickets: Ticket[]; skipped: string[] }> {
  return apiFetch(`/projects/${projectId}/tickets`, { method: "POST", body: JSON.stringify({ findingIds }) });
}

export function updateTicketStatus(projectId: string, ticketId: string, status: TicketStatus): Promise<{ ticket: Ticket }> {
  return apiFetch(`/projects/${projectId}/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status }) });
}

// Reopens a Done ticket whose finding is still open so triage can drive
// remediation again (e.g. after a stale Done was inherited from Jira).
export function reopenTicket(projectId: string, ticketId: string): Promise<{ ticket: Ticket }> {
  return apiFetch(`/projects/${projectId}/tickets/${ticketId}/reopen`, { method: "POST" });
}

// For a ticket whose CI verification is stuck (failed, or left at
// 'pending_setup' from before the repo's bootstrap PR merged) — nothing else
// retries it automatically.
export function retryTicketPipeline(projectId: string, ticketId: string): Promise<{ queued: boolean }> {
  return apiFetch(`/projects/${projectId}/tickets/${ticketId}/retry-pipeline`, { method: "POST" });
}

export function retryTicketFix(projectId: string, ticketId: string): Promise<{ queued: boolean }> {
  return apiFetch(`/projects/${projectId}/tickets/${ticketId}/retry-fix`, { method: "POST" });
}

// Also polls GitHub for any ticket with an open pull request and applies
// the merged/closed transition — a fallback for when GitHub's pull_request
// webhook can't reach this backend (e.g. local dev with no public URL), so
// merges aren't stuck waiting on a webhook that will never arrive.
export function syncTicketsToJira(projectId: string): Promise<{
  synced: number;
  failed: number;
  statusPulled: number;
  removed: number;
  reconciled: number;
  imported: number;
  prMerged: number;
  prClosed: number;
}> {
  return apiFetch(`/projects/${projectId}/tickets/sync`, { method: "POST" });
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------

export interface ActivityEvent {
  id: string;
  type: "upload" | "triage" | "ticket" | "sla" | "pipeline";
  actor: string;
  summary: string;
  linkLabel: string | null;
  linkTo: string | null;
  meta: string | null;
  createdAt: string;
}

export interface Overview {
  kpis: {
    totalCvits: number;
    slaBreachedPct: number;
    openTickets: number;
    inReviewTickets: number;
    meanTimeToRemediateDays: number;
  };
  severityDistribution: { label: Severity; count: number; pct: number }[];
  serviceBreakdown: { name: string; total: number; missed: number; approaching: number; onTrack: number }[];
  trend: { date: string; totalFindings: number }[];
  recentActivity: ActivityEvent[];
}

export function getOverview(projectId: string): Promise<{ overview: Overview }> {
  return apiFetch(`/projects/${projectId}/overview`, { method: "GET" });
}

// ---------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------

export interface ActivityFilters {
  type?: string;
  actor?: string;
  [key: string]: string | undefined;
}

export function listActivity(projectId: string, filters: ActivityFilters = {}): Promise<{ activity: ActivityEvent[] }> {
  return apiFetch(`/projects/${projectId}/activity${toQueryString(filters)}`, { method: "GET" });
}

// ---------------------------------------------------------------------
// Members and invites
// ---------------------------------------------------------------------

export type MemberRole = "owner" | "admin" | "editor" | "viewer";

export interface ProjectMember {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  role: MemberRole;
}

export interface PendingProjectInvite {
  id: string;
  token: string;
  email: string;
  role: Exclude<MemberRole, "owner">;
  createdAt: string;
}

export function listMembers(projectId: string): Promise<{ members: ProjectMember[]; invites: PendingProjectInvite[] }> {
  return apiFetch(`/projects/${projectId}/members`, { method: "GET" });
}

export function inviteMember(
  projectId: string,
  input: { email: string; role: Exclude<MemberRole, "owner"> },
): Promise<{ invite: PendingProjectInvite; inviteUrl: string }> {
  return apiFetch(`/projects/${projectId}/members/invite`, { method: "POST", body: JSON.stringify(input) });
}

export function updateMemberRole(projectId: string, memberId: string, role: Exclude<MemberRole, "owner">): Promise<void> {
  return apiFetch(`/projects/${projectId}/members/${memberId}`, { method: "PATCH", body: JSON.stringify({ role }) });
}

export function removeMember(projectId: string, memberId: string): Promise<void> {
  return apiFetch(`/projects/${projectId}/members/${memberId}`, { method: "DELETE" });
}

export function revokeInvite(projectId: string, inviteId: string): Promise<void> {
  return apiFetch(`/projects/${projectId}/members/invites/${inviteId}`, { method: "DELETE" });
}

export interface MyInvite {
  id: string;
  token: string;
  projectId: string | null;
  projectName: string;
  role: Exclude<MemberRole, "owner">;
  createdAt: string;
}

export function listMyInvites(): Promise<{ invites: MyInvite[] }> {
  return apiFetch("/invites", { method: "GET" });
}

export interface InviteDetails {
  id: string;
  projectId: string | null;
  projectName: string;
  role: Exclude<MemberRole, "owner">;
  status: string;
  createdAt: string;
}

export function getInviteByToken(token: string): Promise<InviteDetails> {
  return apiFetch(`/invites/${token}`, { method: "GET" });
}

export function acceptInvite(token: string): Promise<{ projectId: string }> {
  return apiFetch(`/invites/${token}/accept`, { method: "POST" });
}

export function declineInvite(token: string): Promise<void> {
  return apiFetch(`/invites/${token}/decline`, { method: "POST" });
}
