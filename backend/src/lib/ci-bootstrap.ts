import { buildCiWorkflowYaml, CI_BOOTSTRAP_BRANCH, CI_WORKFLOW_PATH } from "./ci-template.js";
import {
  commitFileToBranch,
  createBranch,
  createPullRequest,
  getBranchHeadSha,
  GithubApiError,
  repoFileExists,
  type GithubCredentials,
} from "./github.js";
import { logger } from "./logger.js";
import { detectRepoStack, UNKNOWN_STACK } from "./stack-detect.js";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function createBootstrapPr(creds: GithubCredentials, defaultBranch: string): Promise<{ url: string }> {
  const defaultHeadSha = await getBranchHeadSha(creds, defaultBranch);
  await createBranch(creds, { baseBranch: defaultBranch, branchName: CI_BOOTSTRAP_BRANCH });

  let detected = UNKNOWN_STACK;
  try {
    detected = await detectRepoStack(creds, defaultBranch);
  } catch (err) {
    logger.error({ err, repo: creds.repo }, "Stack detection failed; falling back to placeholder pipeline steps");
  }

  const stackSummary =
    detected.language === "unknown"
      ? "No recognizable stack detected; Build/Functional Test/Integration Test steps are placeholders you must fill in."
      : `Detected stack: ${detected.language === "node" ? "Node.js" : "Python"}; Build/Functional Test/Integration ` +
        "Test commands were auto-filled from the repo; review and customize as needed.";

  try {
    await commitFileToBranch(creds, {
      branch: CI_BOOTSTRAP_BRANCH,
      baseSha: defaultHeadSha,
      message:
        "ci: add Bankai verification workflow\n\n" +
        "Adds .github/workflows/bankai-verify.yml so Bankai can dispatch build/image/deploy-dev/functional-test/" +
        "integration-test verification against future remediation branches. Image and deploy-dev are " +
        "placeholders; customize them for this repo's stack before relying on the results.",
      path: CI_WORKFLOW_PATH,
      content: buildCiWorkflowYaml(detected),
    });
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) {
      throw new GithubApiError(
        `This token can commit to "${creds.repo}" but not to ${CI_WORKFLOW_PATH}; writing GitHub Actions ` +
          `workflow files needs a separate permission. Use a fine-grained token with "Workflows: Read and write", ` +
          `or a classic token with the "workflow" scope alongside "repo".`,
        404,
      );
    }
    throw err;
  }

  const pr = await createPullRequest(creds, {
    head: CI_BOOTSTRAP_BRANCH,
    base: defaultBranch,
    title: "ci: add Bankai verification workflow",
    body:
      "Bankai needs a workflow it can dispatch to verify remediation pull requests " +
      "(build -> image -> deploy-dev -> functional-test -> integration-test). This adds " +
      "`.github/workflows/bankai-verify.yml`.\n\n" +
      `${stackSummary}\n\n` +
      "Once merged, Bankai automatically dispatches this workflow against each remediation branch and " +
      "posts the pass/fail result as a comment on that branch's pull request. A human still reviews and " +
      "merges every remediation PR; this only adds evidence, it never merges anything.",
  });
  return { url: pr.url };
}

export async function ensureCiBootstrapReady(
  supabase: SupabaseClient,
  projectId: string,
  github: { creds: GithubCredentials; defaultBranch: string },
): Promise<boolean> {
  if (await repoFileExists(github.creds, CI_WORKFLOW_PATH, github.defaultBranch)) {
    await supabase.from("projects").update({ ci_bootstrap_status: "ready" }).eq("id", projectId);
    return true;
  }

  const { data: claimed } = await supabase
    .from("projects")
    .update({ ci_bootstrap_status: "pr_open" })
    .eq("id", projectId)
    .eq("ci_bootstrap_status", "none")
    .select("id")
    .maybeSingle();

  if (!claimed) return false;

  try {
    const { url } = await createBootstrapPr(github.creds, github.defaultBranch);
    await supabase.from("projects").update({ ci_bootstrap_pr_url: url }).eq("id", projectId);
  } catch (err) {
    await supabase.from("projects").update({ ci_bootstrap_status: "none" }).eq("id", projectId);
    throw err;
  }

  return false;
}
