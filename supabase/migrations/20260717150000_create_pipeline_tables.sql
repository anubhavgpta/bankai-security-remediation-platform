-- Scan intake, findings (CVITs), tickets and the activity feed. Jira is not
-- integrated yet — tickets are Bankai-internal records with a locally
-- generated key (<project prefix>-<n>), not real Jira issues.

alter table public.projects add column if not exists key_prefix text;
alter table public.projects add column if not exists ticket_seq integer not null default 0;

update public.projects set key_prefix = 'PRJ' where key_prefix is null;

-- ---------------------------------------------------------------------
-- scans: one row per CSV intake attempt (kept even on failure, for history)
-- ---------------------------------------------------------------------
create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  uploaded_by uuid references public.profiles (id) on delete set null,
  filename text not null,
  file_size_bytes integer not null default 0,
  row_count integer not null default 0,
  service_count integer not null default 0,
  new_delta_count integer not null default 0,
  changed_count integer not null default 0,
  resolved_count integer not null default 0,
  in_progress_count integer not null default 0,
  status text not null default 'Done' check (status in ('Done', 'Failed')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists scans_project_id_idx on public.scans (project_id, created_at desc);

alter table public.scans enable row level security;

create policy "Users can view scans of their own projects"
  on public.scans for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "Users can insert scans into their own projects"
  on public.scans for insert
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

-- ---------------------------------------------------------------------
-- findings: current known state per fingerprint (updated in place across
-- scans, not one row per scan-row) — this is what the AI Triage table lists.
-- ---------------------------------------------------------------------
create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scan_id uuid not null references public.scans (id) on delete cascade,
  fingerprint text not null,
  external_id text,
  title text not null,
  severity text not null check (severity in ('Critical', 'High', 'Medium', 'Low')),
  cvss_score numeric,
  cwe text,
  component text,
  file_path text,
  finding_type text,
  source_status text,
  date_found date,
  description text,
  fix_available text,
  source_url text,
  service text,
  bucket text not null default 'New Delta' check (bucket in ('New Delta', 'In Progress', 'Changed', 'Resolved')),
  confidence integer not null default 80,
  rationale text,
  sla_due_date date,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, fingerprint)
);

create index if not exists findings_project_id_idx on public.findings (project_id);

alter table public.findings enable row level security;

create policy "Users can view findings of their own projects"
  on public.findings for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "Users can insert findings into their own projects"
  on public.findings for insert
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "Users can update findings of their own projects"
  on public.findings for update
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

drop trigger if exists set_findings_updated_at on public.findings;

create trigger set_findings_updated_at
  before update on public.findings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- tickets: Bankai-internal tickets created from an accepted finding.
-- ---------------------------------------------------------------------
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  finding_id uuid not null references public.findings (id) on delete cascade,
  key text not null,
  title text not null,
  service text,
  severity text not null check (severity in ('Critical', 'High', 'Medium', 'Low')),
  status text not null default 'To Do' check (status in ('To Do', 'In Progress', 'In Review', 'Done')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key),
  unique (finding_id)
);

create index if not exists tickets_project_id_idx on public.tickets (project_id);

alter table public.tickets enable row level security;

create policy "Users can view tickets of their own projects"
  on public.tickets for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "Users can insert tickets into their own projects"
  on public.tickets for insert
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "Users can update tickets of their own projects"
  on public.tickets for update
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

drop trigger if exists set_tickets_updated_at on public.tickets;

create trigger set_tickets_updated_at
  before update on public.tickets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- activity_events: append-only audit trail feeding the Activity page.
-- ---------------------------------------------------------------------
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  actor_label text not null,
  event_type text not null check (event_type in ('upload', 'triage', 'ticket', 'sla')),
  summary text not null,
  link_label text,
  link_to text,
  meta text,
  created_at timestamptz not null default now()
);

create index if not exists activity_events_project_id_idx on public.activity_events (project_id, created_at desc);

alter table public.activity_events enable row level security;

create policy "Users can view activity of their own projects"
  on public.activity_events for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

create policy "Users can insert activity into their own projects"
  on public.activity_events for insert
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

-- ---------------------------------------------------------------------
-- create_project_ticket: atomically claims the next ticket_seq for a
-- project and inserts the ticket, so two concurrent "mark for Jira" calls
-- can never collide on the same key. Runs as the caller (no SECURITY
-- DEFINER), so the projects RLS update policy still gates access — if the
-- caller doesn't own the project, the UPDATE affects 0 rows and v_seq
-- stays null, which we turn into an explicit error.
-- ---------------------------------------------------------------------
create or replace function public.create_project_ticket(
  p_project_id uuid,
  p_finding_id uuid,
  p_title text,
  p_service text,
  p_severity text,
  p_due_date date
) returns public.tickets
language plpgsql
as $$
declare
  v_seq integer;
  v_prefix text;
  v_ticket public.tickets;
begin
  update public.projects
    set ticket_seq = ticket_seq + 1
    where id = p_project_id
    returning ticket_seq, key_prefix into v_seq, v_prefix;

  if v_seq is null then
    raise exception 'Project not found or not owned by the current user';
  end if;

  insert into public.tickets (project_id, finding_id, key, title, service, severity, due_date)
  values (p_project_id, p_finding_id, coalesce(v_prefix, 'PRJ') || '-' || (100 + v_seq), p_title, p_service, p_severity, p_due_date)
  returning * into v_ticket;

  return v_ticket;
end;
$$;
