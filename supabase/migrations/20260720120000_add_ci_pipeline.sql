-- CI/CD verification pipeline for remediation PRs: Bankai dispatches a
-- GitHub Actions workflow (build -> image -> deploy-dev -> test) against a
-- remediation branch and records the result as evidence on the PR, gating
-- only Bankai's own ci_status field — never GitHub's mergeability.
--
-- workflow_dispatch can only trigger a workflow file that already exists on
-- the repo's default branch, so a repo with no such workflow needs a
-- one-time "bootstrap" PR (adding .github/workflows/bankai-verify.yml)
-- merged by a human before any ticket's pipeline can actually run — the
-- ci_bootstrap_* columns below track that per-project, once.

alter table public.projects add column if not exists ci_bootstrap_status text
  not null default 'none' check (ci_bootstrap_status in ('none', 'pr_open', 'ready'));
alter table public.projects add column if not exists ci_bootstrap_pr_url text;

-- Mirrors the github_branch_*/github_pr_* best-effort-failure-surface
-- pattern: null status means no pipeline has been attempted yet.
alter table public.tickets add column if not exists ci_status text
  check (ci_status in ('pending_setup', 'queued', 'running', 'passed', 'failed'));
alter table public.tickets add column if not exists ci_run_url text;
alter table public.tickets add column if not exists ci_error text;

-- ---------------------------------------------------------------------
-- pipeline_runs: one row per dispatched bankai-verify.yml run. `stages`
-- holds the per-job (build/image/deploy-dev/test) name+conclusion pulled
-- from the Actions Jobs API as a jsonb array rather than fixed columns, so
-- the scaffold template's job names can evolve without a migration.
-- ---------------------------------------------------------------------
create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  github_run_id bigint,
  workflow_file text not null default 'bankai-verify.yml',
  head_branch text not null,
  status text not null default 'queued' check (status in ('queued', 'in_progress', 'completed')),
  conclusion text,
  stages jsonb,
  html_url text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists pipeline_runs_ticket_id_idx on public.pipeline_runs (ticket_id, created_at desc);
create index if not exists pipeline_runs_project_run_id_idx on public.pipeline_runs (project_id, github_run_id)
  where github_run_id is not null;

alter table public.pipeline_runs enable row level security;

create policy "Users can view pipeline runs of their own projects"
  on public.pipeline_runs for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

-- Only the service-role worker/webhook path writes pipeline_runs (no
-- interactive user ever creates or updates one), so no insert/update policy
-- is added here — same convention as scans' worker-only writes bypassing
-- RLS via supabaseAdmin.

alter table public.activity_events drop constraint if exists activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check
  check (event_type in ('upload', 'triage', 'ticket', 'sla', 'pipeline'));
