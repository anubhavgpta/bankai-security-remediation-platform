-- Projects owned by a profile, plus the per-project service list shown on
-- the New Project / Projects pages. CVIT/ticket/SLA stats are not modeled
-- here yet — they depend on the scan-ingestion pipeline, which doesn't
-- exist yet, so the API reports zeros for those until that lands.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text,
  jira_site text,
  jira_key text,
  status text not null default 'not_connected' check (status in ('not_connected', 'active')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_owner_id_idx on public.projects (owner_id);

alter table public.projects enable row level security;

create policy "Users can view their own projects"
  on public.projects for select
  using (auth.uid() = owner_id);

create policy "Users can insert their own projects"
  on public.projects for insert
  with check (auth.uid() = owner_id);

create policy "Users can update their own projects"
  on public.projects for update
  using (auth.uid() = owner_id);

create policy "Users can delete their own projects"
  on public.projects for delete
  using (auth.uid() = owner_id);

drop trigger if exists set_projects_updated_at on public.projects;

create trigger set_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

create table if not exists public.project_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists project_services_project_id_idx on public.project_services (project_id);

alter table public.project_services enable row level security;

-- No direct owner_id column on this table, so policies join back through
-- projects to check ownership.

create policy "Users can view services of their own projects"
  on public.project_services for select
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()
  ));

create policy "Users can insert services into their own projects"
  on public.project_services for insert
  with check (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()
  ));

create policy "Users can delete services from their own projects"
  on public.project_services for delete
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()
  ));
