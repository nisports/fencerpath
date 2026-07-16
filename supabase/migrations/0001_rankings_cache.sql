-- 0001_rankings_cache.sql
--
-- Shared, cross-user cache of scraped fencing rankings (VM/EM selection lists,
-- national rankings, etc.). Populated automatically once a day by the Vercel
-- Cron job in api/cron/sync-rankings.mjs (via lib/vmemScraper.mjs), one row
-- per weapon/age/gender/nation/season/source combo.
--
-- This is DIFFERENT from the existing `user_data` table: `user_data` stores
-- each authenticated user's private app state (one JSON blob per user_id).
-- `rankings_cache` is public, shared reference data — every user's browser
-- reads the SAME rows, so nobody has to manually import a JSON file anymore.
--
-- Run this once in the Supabase SQL editor (or via `supabase db push` if the
-- CLI is set up) before deploying api/cron/sync-rankings.mjs.

create table if not exists public.rankings_cache (
  id            bigint generated always as identity primary key,
  weapon        text        not null,               -- 'epee' | 'foil' | 'sabre'
  age_category  text        not null,                -- 'senior' | 'u23' | 'u20' | 'u17' | 'u15' | 'u13' | 'u11' | 'veteran'
  gender        text        not null,                -- 'M' | 'F'
  nation        text        not null default 'SWE',  -- ISO-ish nation code, e.g. 'SWE'
  season        text        not null,                -- '25/26' short form, matches index.html's seasonOf()/normalizeSeasonKey()
  source        text        not null default 'swe',  -- 'swe' = Swedish federation VM/EM selection list (see mergeSweRankingsPayload / findRankingCacheForCat in index.html)
  scraped_at    timestamptz not null,                -- when Ophardt was actually scraped
  list          jsonb       not null,                -- [{ rank, points, name, rawName }, ...]
  updated_at    timestamptz not null default now(),  -- when this row was last upserted

  -- One row per unique combo. `source` is included so this table can later
  -- hold non-"swe" ranking types (e.g. international EFC/FIE) without
  -- colliding with the Swedish selection-list rows.
  unique (weapon, age_category, gender, nation, season, source)
);

comment on table public.rankings_cache is
  'Shared cache of scraped fencing rankings, synced daily by Vercel Cron (api/cron/sync-rankings.mjs). Public read, service_role-only write.';

-- Fast lookup by the exact combo the frontend queries for
-- (findRankingCacheForCat() in index.html).
create index if not exists rankings_cache_lookup_idx
  on public.rankings_cache (weapon, age_category, gender, nation, season);

-- ── Row Level Security ─────────────────────────────────────────────────────
-- Everyone (including anonymous/anon-key browser clients) can READ.
-- Nobody can INSERT/UPDATE/DELETE via the anon key — only the cron function,
-- authenticating with SUPABASE_SERVICE_ROLE_KEY (which bypasses RLS
-- entirely), can write. So there are deliberately NO write policies below.

alter table public.rankings_cache enable row level security;

drop policy if exists "rankings_cache_public_read" on public.rankings_cache;
create policy "rankings_cache_public_read"
  on public.rankings_cache
  for select
  to anon, authenticated
  using (true);

-- As of the 2026 Supabase Data API change, new public-schema tables are no longer
-- auto-exposed via PostgREST — they need an explicit GRANT even with RLS policies
-- in place, or every request 404s with PGRST205 ("Could not find the table in the
-- schema cache"). RLS still governs row visibility on top of this.
grant usage on schema public to anon, authenticated, service_role;
grant select on public.rankings_cache to anon, authenticated;
grant select, insert, update, delete on public.rankings_cache to service_role;

-- Make sure PostgREST picks up the new table/grants immediately instead of
-- waiting for its next periodic schema cache refresh.
notify pgrst, 'reload schema';
