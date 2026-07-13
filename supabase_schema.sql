-- FencerPath: Phase 1 cloud sync schema
-- Run this once in Supabase Dashboard -> SQL Editor

create table if not exists user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh on every write
create or replace function touch_user_data_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_user_data on user_data;
create trigger trg_touch_user_data
before update on user_data
for each row execute function touch_user_data_updated_at();

-- Row Level Security: each user can only read/write their own row
alter table user_data enable row level security;

drop policy if exists "select own row" on user_data;
create policy "select own row" on user_data
  for select using (auth.uid() = user_id);

drop policy if exists "insert own row" on user_data;
create policy "insert own row" on user_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own row" on user_data;
create policy "update own row" on user_data
  for update using (auth.uid() = user_id);
