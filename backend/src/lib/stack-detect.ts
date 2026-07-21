import { getBlob, getTree, type GitTreeEntry, type GithubCredentials } from "./github.js";
import type { DetectedStack } from "./ci-template.js";
import { logger } from "./logger.js";

const PLACEHOLDER = {
  build: `echo "TODO - add this repo's build steps here"`,
  functionalTest: `echo "TODO - add this repo's FT test commands here"`,
  integrationTest: `echo "TODO - add this repo's IT test commands here"`,
};

// Same wording as bankai-verify.yml's original static placeholders — a repo
// with no recognizable stack behaves identically to before this change.
export const UNKNOWN_STACK: DetectedStack = {
  language: "unknown",
  installCmd: "",
  buildCmd: PLACEHOLDER.build,
  functionalTestCmd: PLACEHOLDER.functionalTest,
  integrationTestCmd: PLACEHOLDER.integrationTest,
};

interface PackageJson {
  scripts?: Record<string, string>;
}

// Best-effort — never throws. Detection failure (or an unrecognized stack)
// must never block the bootstrap PR; callers should fall back to
// UNKNOWN_STACK on any error, same contract as the rest of this codebase's
// external-call sites.
export async function detectRepoStack(creds: GithubCredentials, ref: string): Promise<DetectedStack> {
  const tree = await getTree(creds, ref);

  // Root-level only, so a package.json/requirements.txt nested inside
  // node_modules or a sub-package can't be mistaken for the repo's own stack.
  const rootFiles = new Map<string, GitTreeEntry>();
  for (const entry of tree) {
    if (entry.type === "blob" && !entry.path.includes("/")) {
      rootFiles.set(entry.path, entry);
    }
  }

  const packageJsonEntry = rootFiles.get("package.json");
  if (packageJsonEntry) {
    return detectNodeStack(creds, rootFiles, packageJsonEntry);
  }

  if (rootFiles.has("requirements.txt") || rootFiles.has("pyproject.toml")) {
    return detectPythonStack(rootFiles);
  }

  return UNKNOWN_STACK;
}

async function detectNodeStack(
  creds: GithubCredentials,
  rootFiles: Map<string, GitTreeEntry>,
  packageJsonEntry: GitTreeEntry,
): Promise<DetectedStack> {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await getBlob(creds, packageJsonEntry.sha)) as PackageJson;
  } catch (err) {
    logger.error({ err, repo: creds.repo }, "Could not parse package.json for stack detection — falling back to placeholders");
    return UNKNOWN_STACK;
  }

  const scripts = pkg.scripts ?? {};
  const pm = rootFiles.has("pnpm-lock.yaml") ? "pnpm" : rootFiles.has("yarn.lock") ? "yarn" : "npm";
  const run = (script: string): string => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);

  const installCmd =
    pm === "pnpm"
      ? "corepack enable && pnpm install --frozen-lockfile"
      : pm === "yarn"
        ? "yarn install --frozen-lockfile"
        : rootFiles.has("package-lock.json")
          ? "npm ci"
          : "npm install";

  const buildCmd = scripts.build ? run("build") : `echo "No build script found in package.json — customize this step"`;

  const functionalTestCmd = scripts["test:functional"]
    ? run("test:functional")
    : scripts.test
      ? run("test")
      : PLACEHOLDER.functionalTest;

  // A repo with only a generic `test` script still gets a working (if
  // redundant) two-stage pipeline instead of a blocked integration-test job.
  const integrationTestCmd = scripts["test:integration"]
    ? run("test:integration")
    : functionalTestCmd !== PLACEHOLDER.functionalTest
      ? functionalTestCmd
      : PLACEHOLDER.integrationTest;

  return { language: "node", installCmd, buildCmd, functionalTestCmd, integrationTestCmd };
}

function detectPythonStack(rootFiles: Map<string, GitTreeEntry>): DetectedStack {
  return {
    language: "python",
    installCmd: rootFiles.has("requirements.txt") ? "pip install -r requirements.txt" : "pip install .",
    // Python has no universal build-script convention analogous to `npm run build`.
    buildCmd: `echo "No build step for Python projects — customize if this repo packages artifacts"`,
    // No scripts-manifest to key differentiated FT/IT commands off — both run
    // the same generic pytest invocation; customize with -m functional/-m
    // integration markers once merged.
    functionalTestCmd: "pytest",
    integrationTestCmd: "pytest",
  };
}
