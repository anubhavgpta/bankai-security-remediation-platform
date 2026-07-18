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

export function getSession(): Promise<{ user: PublicUser }> {
  return apiFetch("/auth/session", { method: "GET" });
}

export function updateProfile(input: { fullName: string }): Promise<{ user: PublicUser }> {
  return apiFetch("/auth/profile", { method: "PATCH", body: JSON.stringify(input) });
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return apiFetch("/auth/password", { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteAccount(password: string): Promise<void> {
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
  services?: string[];
}): Promise<{ project: Project }> {
  return apiFetch("/projects", { method: "POST", body: JSON.stringify(input) });
}

export function deleteProject(id: string, confirmName: string): Promise<void> {
  return apiFetch(`/projects/${id}`, { method: "DELETE", body: JSON.stringify({ confirmName }) });
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
): Promise<JiraConnection> {
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
  filename: string;
  fileSizeBytes: number;
  rowCount: number;
  serviceCount: number;
  newDeltaCount: number;
  changedCount: number;
  inProgressCount: number;
  resolvedCount: number;
  status: "Done" | "Failed";
  errorMessage: string | null;
  createdAt: string;
}

export function listScans(projectId: string): Promise<{ scans: Scan[] }> {
  return apiFetch(`/projects/${projectId}/scans`, { method: "GET" });
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
  ticketKey: string | null;
  createdAt: string;
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

export type TicketStatus = "To Do" | "In Progress" | "In Review" | "Done";

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

export function syncTicketsToJira(projectId: string): Promise<{ synced: number; failed: number; statusPulled: number; removed: number }> {
  return apiFetch(`/projects/${projectId}/tickets/sync`, { method: "POST" });
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------

export interface ActivityEvent {
  id: string;
  type: "upload" | "triage" | "ticket" | "sla";
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
