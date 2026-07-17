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
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
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
