import { PIPELINE_STAGE_ORDER, type PipelineStageName } from "./pipeline-types.js";

// Scaffold workflow Bankai commits to a target repo's default branch (via a
// one-time bootstrap PR — see pipeline.job.ts) when the repo has no
// .github/workflows/bankai-verify.yml of its own yet. Bankai only dispatches
// this by filename and reads its result. build/functional-test/integration-test
// get real commands auto-detected from the repo (see stack-detect.ts) where
// that's safely inferable; image/deploy-dev stay placeholders since a
// container registry or dev-deploy target can't be guessed.
export const CI_WORKFLOW_FILE = "bankai-verify.yml";
export const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW_FILE}`;

// The branch (and PR head ref) for the one-time bootstrap PR that adds
// CI_WORKFLOW_PATH to a target repo's default branch — shared between
// pipeline.job.ts (which opens it) and webhook.controller.ts (which
// recognizes its merge/close events as distinct from a remediation PR's).
export const CI_BOOTSTRAP_BRANCH = "bankai/ci-bootstrap";

export interface DetectedStack {
  language: "node" | "python" | "unknown";
  installCmd: string;
  buildCmd: string;
  functionalTestCmd: string;
  integrationTestCmd: string;
}

function composeStep(installCmd: string, cmd: string): string {
  return installCmd ? `${installCmd} && ${cmd}` : cmd;
}

function jobBody(stage: PipelineStageName, detected: DetectedStack): string {
  switch (stage) {
    case "build":
      return (
        `    runs-on: ubuntu-latest\n` +
        `    steps:\n` +
        `      - uses: actions/checkout@v4\n` +
        `      # Detected stack: ${detected.language}\n` +
        `      - run: ${composeStep(detected.installCmd, detected.buildCmd)}\n`
      );
    case "image":
      return (
        `    runs-on: ubuntu-latest\n` +
        `    steps:\n` +
        `      - uses: actions/checkout@v4\n` +
        `      # TODO: build (and optionally push) a container image, e.g.:\n` +
        `      #   - run: docker build -t my-app:\${{ github.sha }} .\n` +
        `      - run: echo "TODO - add this repo's image build steps here"\n`
      );
    case "deploy-dev":
      return (
        `    runs-on: ubuntu-latest\n` +
        `    steps:\n` +
        `      # TODO: deploy the image to this repo's own dev environment. Bankai\n` +
        `      # does not provision or host this environment — it only waits for this\n` +
        `      # job to report pass/fail.\n` +
        `      - run: echo "TODO - add this repo's dev-deploy steps here"\n`
      );
    case "functional-test":
      return (
        `    runs-on: ubuntu-latest\n` +
        `    steps:\n` +
        `      - uses: actions/checkout@v4\n` +
        `      - run: ${composeStep(detected.installCmd, detected.functionalTestCmd)}\n`
      );
    case "integration-test":
      return (
        `    runs-on: ubuntu-latest\n` +
        `    steps:\n` +
        `      - uses: actions/checkout@v4\n` +
        `      - run: ${composeStep(detected.installCmd, detected.integrationTestCmd)}\n`
      );
  }
}

// Builds the bankai-verify.yml contents for a target repo's detected stack.
// Job order/needs-chaining is driven by PIPELINE_STAGE_ORDER (pipeline-types.ts)
// so this generator and the evidence renderers (webhook.controller.ts, jira.ts)
// can never disagree on stage names or ordering.
export function buildCiWorkflowYaml(detected: DetectedStack): string {
  const jobsYaml = PIPELINE_STAGE_ORDER.map((stage, i) => {
    const needsLine = i > 0 ? `    needs: ${PIPELINE_STAGE_ORDER[i - 1]}\n` : "";
    return `  ${stage}:\n${needsLine}${jobBody(stage, detected)}`;
  }).join("\n");

  return (
    `name: Bankai Verify\n\n` +
    `# Dispatched by Bankai after it opens a remediation pull request, targeting\n` +
    `# the remediation branch as \`ref\`. Not triggered on push/pull_request — this\n` +
    `# workflow only ever runs on-demand, once per remediation PR.\n` +
    `on:\n` +
    `  workflow_dispatch:\n` +
    `    inputs:\n` +
    `      ticket_id:\n` +
    `        description: Bankai ticket id this run verifies (for correlation only)\n` +
    `        required: false\n` +
    `        type: string\n\n` +
    `jobs:\n${jobsYaml}`
  );
}
