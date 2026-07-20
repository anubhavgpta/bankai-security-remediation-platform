import { createHash } from "node:crypto";
import { logger } from "./logger.js";

export interface GithubCredentials {
  repo: string; // "owner/repo"
  token: string;
}

export class GithubApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

function githubFetch(creds: GithubCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
}

export async function getBranchHeadSha(creds: GithubCredentials, branch: string): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (res.status === 404) {
    throw new GithubApiError(`Branch "${branch}" was not found in ${creds.repo}.`, 404);
  }
  if (!res.ok) {
    throw new GithubApiError(`Could not read the branch ref (status ${res.status}).`, res.status);
  }
  const { object } = (await res.json()) as { object: { sha: string } };
  return object.sha;
}

export interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

// One call, recursive — returns every path in the repo at `ref` (a branch
// name or a commit sha) with its blob sha and size, so file filtering can
// happen on this metadata before any file content is downloaded.
export async function getTree(creds: GithubCredentials, ref: string): Promise<GitTreeEntry[]> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (res.status === 404) {
    throw new GithubApiError(`Ref "${ref}" was not found in ${creds.repo}.`, 404);
  }
  if (!res.ok) {
    throw new GithubApiError(`Could not read the repository tree (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { tree: GitTreeEntry[]; truncated?: boolean };
  if (body.truncated) {
    logger.warn({ repo: creds.repo, ref }, "GitHub truncated the tree response — this repo has more files than the API returns in one call");
  }
  return body.tree;
}

export async function getBlob(creds: GithubCredentials, sha: string): Promise<string> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/git/blobs/${sha}`);
  if (!res.ok) {
    throw new GithubApiError(`Could not read a file blob (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { content: string; encoding: string };
  if (body.encoding !== "base64") {
    throw new GithubApiError(`Unexpected blob encoding "${body.encoding}".`);
  }
  return Buffer.from(body.content, "base64").toString("utf8");
}

export interface FetchableFile {
  path: string;
  sha: string;
}

// Fetches blob content for each file with bounded concurrency, so scanning
// a few hundred files doesn't fire a few hundred simultaneous requests at
// GitHub's REST API. A file that fails to fetch is dropped (logged), not
// fatal to the rest of the scan — mirrors this codebase's best-effort
// philosophy for external calls elsewhere.
export async function getBlobs(
  creds: GithubCredentials,
  files: FetchableFile[],
  concurrency = 5,
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index]!;
      try {
        const content = await getBlob(creds, file.sha);
        results.push({ path: file.path, content });
      } catch (err) {
        logger.error({ err, path: file.path }, "Could not fetch a file's contents for scanning — skipping it");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  return results;
}

export interface CompareFileEntry {
  path: string;
  previousPath: string | null;
  sha: string | null; // blob sha at `head`; null for a removed file (no content there)
  status: "added" | "modified" | "removed" | "renamed" | "changed" | "copied";
}

// Used for incremental (webhook-triggered) scans — gives the changed-file
// list directly between two commits, so the worker can skip the full-repo
// tree walk and only re-fetch what actually changed.
export async function compareCommits(creds: GithubCredentials, base: string, head: string): Promise<CompareFileEntry[]> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  if (!res.ok) {
    throw new GithubApiError(`Could not compare commits (status ${res.status}).`, res.status);
  }
  const body = (await res.json()) as {
    files?: { filename: string; previous_filename?: string; status: string; sha: string }[];
  };
  return (body.files ?? []).map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    sha: f.status === "removed" ? null : f.sha,
    status: f.status as CompareFileEntry["status"],
  }));
}

export interface RegisteredWebhook {
  id: string;
}

// Best-effort by design (see github.controller.ts's connectGithub): many
// fine-grained PATs don't include the "Webhooks: write" permission, so a
// 403/404 here is the common case, not exceptional — callers must not
// treat it as a connect failure.
export async function registerWebhook(creds: GithubCredentials, input: { url: string; secret: string }): Promise<RegisteredWebhook> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: { url: input.url, content_type: "json", secret: input.secret, insecure_ssl: "0" },
    }),
  });

  if (res.status === 403 || res.status === 404) {
    throw new GithubApiError("This token cannot manage webhooks for this repository.", res.status);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubApiError(body.message ?? `Could not create the webhook (status ${res.status}).`, res.status);
  }

  const body = (await res.json()) as { id: number };
  return { id: String(body.id) };
}

// Best-effort — called during disconnect; a failure here must not block
// clearing the project's GitHub connection.
export async function deleteWebhook(creds: GithubCredentials, hookId: string): Promise<void> {
  const res = await githubFetch(creds, `/repos/${creds.repo}/hooks/${encodeURIComponent(hookId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new GithubApiError(`Could not remove the webhook (status ${res.status}).`, res.status);
  }
}

export async function verifyConnection(creds: GithubCredentials): Promise<{ defaultBranch: string }> {
  let res: Response;
  try {
    res = await githubFetch(creds, `/repos/${creds.repo}`);
  } catch {
    throw new GithubApiError("Could not reach GitHub — check your network connection.");
  }
  if (res.status === 401) throw new GithubApiError("Invalid GitHub token.", 401);
  if (res.status === 404) throw new GithubApiError(`Repository "${creds.repo}" was not found, or the token lacks access.`, 404);
  if (!res.ok) throw new GithubApiError(`Could not reach GitHub (status ${res.status}).`, res.status);

  const body = (await res.json()) as { default_branch?: string };
  if (!body.default_branch) throw new GithubApiError("Could not determine the repository's default branch.");
  return { defaultBranch: body.default_branch };
}

// Slugifies a finding title into a short, branch-name-safe segment.
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Deterministic identity segment: two unrelated Bankai accounts creating a
// ticket for the same vulnerability (same fingerprint) on the same repo
// must produce the identical branch name, so createBranch's existing
// 422-idempotency (below) naturally converges them onto one branch instead
// of creating a duplicate. Short hex slice, not the full digest — this is
// a collision-avoidance identifier, not a security boundary.
function fingerprintSlug(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 10);
}

export function buildBranchName(fingerprint: string, cwe: string | null, filePath: string | null): string {
  const readable = [cwe, filePath ? filePath.split("/").pop() : null]
    .filter((s): s is string => !!s)
    .map(slug)
    .filter(Boolean)
    .join("-");
  return `remediation/${fingerprintSlug(fingerprint)}${readable ? `-${readable}` : ""}`;
}

// Never throws — same best-effort contract as jira.ts's deleteIssue. A 404
// counts as success (already gone either way, e.g. merged/deleted manually).
// branchName is NOT URL-encoded as a whole: buildBranchName's output
// ("remediation/<key>-<slug>") contains an intentional "/" that must stay
// literal in the path, and every character it can contain is already
// URL-safe (lowercase alphanumerics and hyphens only).
export async function deleteBranch(creds: GithubCredentials, branchName: string): Promise<boolean> {
  try {
    const res = await githubFetch(creds, `/repos/${creds.repo}/git/refs/heads/${branchName}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export interface CreatedBranch {
  name: string;
  url: string;
}

// Idempotent: if the branch already exists (422 "Reference already exists"),
// this returns the existing branch instead of throwing — a ticket's branch
// creation may be retried (e.g. via syncTickets) without producing an error.
// Since buildBranchName derives the name from the vulnerability's own
// fingerprint rather than any account-local ticket key, this idempotency
// also naturally covers two unrelated Bankai accounts creating a ticket for
// the same vulnerability on the same repo — the second call resolves to the
// first account's branch instead of creating a duplicate.
export async function createBranch(
  creds: GithubCredentials,
  input: { baseBranch: string; branchName: string },
): Promise<CreatedBranch> {
  let baseSha: string;
  try {
    baseSha = await getBranchHeadSha(creds, input.baseBranch);
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) {
      throw new GithubApiError(`Base branch "${input.baseBranch}" was not found in ${creds.repo}.`, 404);
    }
    throw err;
  }

  const createRes = await githubFetch(creds, `/repos/${creds.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: baseSha }),
  });

  if (createRes.ok) {
    return { name: input.branchName, url: `https://github.com/${creds.repo}/tree/${input.branchName}` };
  }

  if (createRes.status === 422) {
    const body = (await createRes.json().catch(() => ({}))) as { message?: string };
    if (body.message?.includes("Reference already exists")) {
      return { name: input.branchName, url: `https://github.com/${creds.repo}/tree/${input.branchName}` };
    }
  }

  if (createRes.status === 403) {
    throw new GithubApiError(
      "GitHub token lacks write access to create branches. Use a fine-grained token with " +
        `"Contents: Read and write" for ${creds.repo}, or a classic token with the "repo" scope.`,
      403,
    );
  }

  const body = (await createRes.json().catch(() => ({}))) as { message?: string };
  throw new GithubApiError(body.message ?? `Branch creation failed (status ${createRes.status}).`, createRes.status);
}
