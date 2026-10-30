-- Pulse cloud sync table. Paste into Supabase → SQL Editor → Run.
-- Each person can only ever read/write their own rows (row level security).

create table if not exists public.pulse_records (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  kind       text    not null,
  id         text    not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,
  synced_at  timestamptz not null default clock_timestamp(),
  primary key (user_id, kind, id)
);

create index if not exists pulse_records_sync_idx on public.pulse_records (user_id, synced_at);

alter table public.pulse_records enable row level security;

drop policy if exists "own rows" on public.pulse_records;
create policy "own rows" on public.pulse_records
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Server-side timestamp so devices with slightly wrong clocks still sync.
create or replace function public.pulse_touch() returns trigger
language plpgsql as $$
begin
  new.synced_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists pulse_touch on public.pulse_records;
create trigger pulse_touch before insert or update on public.pulse_records
  for each row execute function public.pulse_touch();
