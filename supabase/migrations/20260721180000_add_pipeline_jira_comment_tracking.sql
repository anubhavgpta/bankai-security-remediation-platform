-- Dedup guard for the new "post pipeline evidence as a Jira comment"
-- feature (webhook.controller.ts / jira.ts addPipelineEvidenceComment).
-- workflow_run is an at-least-once GitHub webhook (retries on non-2xx, plus
-- manual redelivery from GitHub's UI), so without this a redelivered event
-- would post a duplicate comment onto the Jira issue.

alter table public.pipeline_runs add column if not exists jira_comment_posted_at timestamptz;
