// One-off ops script — run once after this deploy:
//   npx tsx backend/scripts/backfill-pr-webhooks.ts
//
// registerWebhook (backend/src/lib/github.ts) now subscribes new webhooks to
// both "push" and "pull_request" events, but every project connected before
// that change has a hook registered with "push" only — its ticket will
// never see a merge and flip to "Done" until the hook is updated. This
// walks every project with a registered webhook and adds "pull_request" to
// its subscribed events.
//
// Best-effort per project: one project with a revoked/expired token must not
// abort the run for every other project.
import { decrypt } from "../src/lib/crypto.js";
import { GithubApiError, updateWebhookEvents } from "../src/lib/github.js";
import { supabaseAdmin } from "../src/lib/supabase.js";

interface ProjectRow {
  id: string;
  name: string;
  github_repo: string;
  github_token_enc: string;
  github_webhook_id: string;
}

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, name, github_repo, github_token_enc, github_webhook_id")
    .not("github_connected_at", "is", null)
    .not("github_webhook_id", "is", null);

  if (error) {
    console.error("Could not load GitHub-connected projects:", error);
    process.exitCode = 1;
    return;
  }

  const projects = (data ?? []) as ProjectRow[];
  console.log(`Found ${projects.length} project(s) with a registered webhook.`);

  let updated = 0;
  let failed = 0;

  for (const project of projects) {
    try {
      const creds = { repo: project.github_repo, token: decrypt(project.github_token_enc) };
      await updateWebhookEvents(creds, project.github_webhook_id, ["push", "pull_request"]);
      console.log(`✓ ${project.name} (${project.github_repo})`);
      updated++;
    } catch (err) {
      const message = err instanceof GithubApiError ? err.message : err instanceof Error ? err.message : String(err);
      console.error(`✗ ${project.name} (${project.github_repo}): ${message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${updated} updated, ${failed} failed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
