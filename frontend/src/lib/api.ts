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

export interface ProjectStats {
  totalCvits: number;
  slaBreachedPct: number;
  openTickets: number;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: "not_connected" | "active";
  services: string[];
  jiraSite: string | null;
  jiraKey: string | null;
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
  jiraSite?: string;
  jiraKey?: string;
}): Promise<{ project: Project }> {
  return apiFetch("/projects", { method: "POST", body: JSON.stringify(input) });
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
