-- Mirrors auth.users into a queryable public table, kept in sync by a
-- trigger. App tables (projects, tickets, ...) should foreign-key to
-- profiles.id rather than referencing auth.users directly, since the auth
-- schema isn't meant to be queried or joined against from app logic/RLS.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- No insert/delete policy for end users: rows are created only by the
-- trigger below (running as the function owner, not the requesting user)
-- and deleted only via the `on delete cascade` when the auth.users row goes.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before this migration ran.
insert into public.profiles (id, full_name)
select id, raw_user_meta_data ->> 'full_name'
from auth.users
on conflict (id) do nothing;
