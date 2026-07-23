-- Low-confidence AI fixes now still open a pull request (flagged for extra
-- human scrutiny) instead of being dropped with github_pr_error. This flag
-- records that the fix behind the ticket's PR was low-confidence so the UI
-- can warn the reviewer.
alter table public.tickets
  add column github_pr_low_confidence boolean not null default false;
