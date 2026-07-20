-- PR-lifecycle tracking for the AI-generated-fix flow (a fix is committed to
-- the existing remediation branch, then a PR is opened from it) — mirrors
-- the github_branch_* columns' shape/contract exactly.

alter table public.tickets add column if not exists github_pr_number integer;
alter table public.tickets add column if not exists github_pr_url text;
alter table public.tickets add column if not exists github_pr_state text
  check (github_pr_state in ('open', 'merged', 'closed'));
alter table public.tickets add column if not exists github_pr_error text;

-- The commit sha of the AI-authored fix Bankai itself pushed to the branch —
-- lets a retried/re-entrant fix-pr job tell "we already committed, just the
-- PR-open step failed" apart from "nothing committed yet", without an extra
-- GitHub round trip (compare this to the branch's current head sha; if they
-- still match, skip straight to PR creation).
alter table public.tickets add column if not exists github_fix_commit_sha text;

create index if not exists tickets_project_pr_number_idx
  on public.tickets (project_id, github_pr_number)
  where github_pr_number is not null;
