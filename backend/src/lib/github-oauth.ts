import { env } from "../env.js";
import { GithubApiError } from "./github.js";

// Account-scoped GitHub OAuth App calls — deliberately separate from
// lib/github.ts's GithubCredentials = {repo, token} shape, since these
// calls (authorize/token-exchange/whoami/list-repos) have no specific repo
// yet. Same raw-fetch + bearer-token convention as lib/github.ts, no new
// dependency.

function callbackUrl(): string {
  const base = env.BACKEND_PUBLIC_URL ?? `http://localhost:${env.PORT}`;
  return `${base}/api/auth/github/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(),
    // "workflow" is required in addition to "repo" to write/update files
    // under .github/workflows/ (the CI bootstrap PR) — GitHub rejects that
    // specific path with a 404 under "repo" alone, same split as classic
    // PATs' "workflow" scope.
    scope: "repo,workflow",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface GithubOAuthToken {
  token: string;
  scope: string;
}

export async function exchangeCodeForToken(code: string): Promise<GithubOAuthToken> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(),
    }),
  });

  if (!res.ok) {
    throw new GithubApiError(`Could not exchange the GitHub authorization code (status ${res.status}).`, res.status);
  }

  const body = (await res.json()) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!body.access_token) {
    throw new GithubApiError(body.error_description ?? body.error ?? "GitHub did not return an access token.");
  }

  return { token: body.access_token, scope: body.scope ?? "" };
}

export interface GithubAccountIdentity {
  id: string;
  login: string;
}

export async function getAuthenticatedGithubUser(token: string): Promise<GithubAccountIdentity> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (res.status === 401) {
    throw new GithubApiError("This GitHub authorization is no longer valid.", 401);
  }
  if (!res.ok) {
    throw new GithubApiError(`Could not read the authenticated GitHub user (status ${res.status}).`, res.status);
  }

  const body = (await res.json()) as { id: number; login: string };
  return { id: String(body.id), login: body.login };
}

export interface GithubUserRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

const MAX_REPO_PAGES = 5; // ~500 repos at 100/page — a deliberate cap, not a bug, for very large accounts.

export async function listAuthenticatedUserRepos(token: string): Promise<GithubUserRepo[]> {
  const repos: GithubUserRepo[] = [];

  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const params = new URLSearchParams({
      sort: "pushed",
      per_page: "100",
      page: String(page),
      affiliation: "owner,collaborator,organization_member",
    });
    const res = await fetch(`https://api.github.com/user/repos?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.status === 401) {
      throw new GithubApiError("This GitHub authorization is no longer valid.", 401);
    }
    if (!res.ok) {
      throw new GithubApiError(`Could not list GitHub repositories (status ${res.status}).`, res.status);
    }

    const body = (await res.json()) as { full_name: string; private: boolean; default_branch: string; pushed_at: string | null }[];
    for (const repo of body) {
      repos.push({ fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, pushedAt: repo.pushed_at });
    }

    if (body.length < 100) break; // last page
  }

  return repos;
}
