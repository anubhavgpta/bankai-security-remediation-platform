export type Severity = "Critical" | "High" | "Medium" | "Low";
export type Bucket = "New Delta" | "In Progress" | "Changed" | "Resolved";
export type SlaStatus = "Missed" | "Approaching" | "On track";
export type TicketStatus = "To Do" | "In Progress" | "In Review" | "Done";
export type CiStatus = "pending_setup" | "queued" | "running" | "passed" | "failed";

// Single source of truth for the bankai-verify.yml job graph — consumed by
// both the YAML generator (ci-template.ts) and the evidence renderers
// (webhook.controller.ts, jira.ts) so job keys, needs: order, and display
// labels can never drift apart.
export type PipelineStageName = "build" | "image" | "deploy-dev" | "functional-test" | "integration-test";

export const PIPELINE_STAGE_ORDER: PipelineStageName[] = [
  "build",
  "image",
  "deploy-dev",
  "functional-test",
  "integration-test",
];

export const PIPELINE_STAGE_LABELS: Record<PipelineStageName, string> = {
  "build": "Build (CI)",
  "image": "Image",
  "deploy-dev": "Deploy Dev (CD)",
  "functional-test": "Functional Test",
  "integration-test": "Integration Test",
};
