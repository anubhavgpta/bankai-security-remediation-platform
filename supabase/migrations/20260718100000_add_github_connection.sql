-- GitHub connection (Personal Access Token) per project, mirroring the Jira
-- connection columns. github_connected_at is the source of truth for
-- "is GitHub actually connected", same convention as jira_connected_at.

alter table public.projects add column if not exists github_repo text;
alter table public.projects add column if not exists github_token_enc text;
alter table public.projects add column if not exists github_default_branch text;
alter table public.projects add column if not exists github_connected_at timestamptz;

alter table public.tickets add column if not exists github_branch_name text;
alter table public.tickets add column if not exists github_branch_url text;
alter table public.tickets add column if not exists github_branch_error text;
