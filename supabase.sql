-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- One row per signed-in user, holding that user's taste profile. Row Level Security makes sure
-- each person can only ever read or change their own row.

create table if not exists public.user_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

create policy "read own profile"   on public.user_data for select to authenticated using (auth.uid() = user_id);
create policy "create own profile" on public.user_data for insert to authenticated with check (auth.uid() = user_id);
create policy "update own profile" on public.user_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
