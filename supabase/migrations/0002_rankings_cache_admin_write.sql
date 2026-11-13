-- 0002_rankings_cache_admin_write.sql
--
-- Ophardt now serves a Cloudflare bot challenge (~2026-11-03), so the Vercel
-- cron can no longer scrape rankings. The admin pastes ranking tables into the
-- app instead (importPastedRanking() in app/index.html), which upserts here
-- with the signed-in user's JWT. Allow that for the admin account only;
-- everyone else stays read-only.

drop policy if exists "rankings_cache_admin_write" on public.rankings_cache;
create policy "rankings_cache_admin_write"
  on public.rankings_cache
  for all
  to authenticated
  using      (lower(auth.jwt() ->> 'email') = 'tina.zhu@nisports.se')
  with check (lower(auth.jwt() ->> 'email') = 'tina.zhu@nisports.se');

grant insert, update on public.rankings_cache to authenticated;

notify pgrst, 'reload schema';
