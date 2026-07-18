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

export function buildBranchName(ticketKey: string, title: string): string {
  const suffix = slug(title);
  return `remediation/${ticketKey.toLowerCase()}${suffix ? `-${suffix}` : ""}`;
}

export interface CreatedBranch {
  name: string;
  url: string;
}

// Idempotent: if the branch already exists (422 "Reference already exists"),
// this returns the existing branch instead of throwing — a ticket's branch
// creation may be retried (e.g. via syncTickets) without producing an error.
export async function createBranch(
  creds: GithubCredentials,
  input: { baseBranch: string; branchName: string },
): Promise<CreatedBranch> {
  const refRes = await githubFetch(creds, `/repos/${creds.repo}/git/ref/heads/${encodeURIComponent(input.baseBranch)}`);
  if (refRes.status === 404) {
    throw new GithubApiError(`Base branch "${input.baseBranch}" was not found in ${creds.repo}.`, 404);
  }
  if (!refRes.ok) {
    throw new GithubApiError(`Could not read the base branch (status ${refRes.status}).`, refRes.status);
  }
  const { object } = (await refRes.json()) as { object: { sha: string } };

  const createRes = await githubFetch(creds, `/repos/${creds.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: object.sha }),
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
