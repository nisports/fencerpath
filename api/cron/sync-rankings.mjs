/**
 * api/cron/sync-rankings.mjs
 *
 * Vercel Serverless Function, invoked once a day by Vercel Cron (see
 * vercel.json — one cron entry per weapon/age/gender combo, each hitting
 * this same function with different query params).
 *
 * What it does:
 *   1. Scrapes the Swedish federation's "Uttagning VM/EM" selection list for
 *      ONE weapon/age/gender combo, via the shared lib/vmemScraper.mjs
 *      module (the exact same logic scrape_vmem_rankings.mjs uses locally —
 *      keeping one source of truth for Ophardt's HTML parsing).
 *   2. Upserts the result into the shared Supabase `rankings_cache` table
 *      (see supabase/migrations/0001_rankings_cache.sql), using the
 *      SUPABASE_SERVICE_ROLE_KEY so it can write despite RLS only allowing
 *      public SELECT.
 *
 * Every FencerPath user's browser then reads this same shared table (via
 * the public anon key, read-only) instead of anyone needing to manually
 * run the CLI script and import a JSON file.
 *
 * Query params (all required except season/nation):
 *   ?weapon=epee|foil|sabre
 *   &age=senior|u23|u20|u17|u15|u13|u11|veteran
 *   &gender=M|F
 *   &season=25/26        (optional — defaults to the current season)
 *
 * Auth: Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET`
 * when the CRON_SECRET env var is set on the project. We verify that header
 * so this endpoint can't be triggered by a random public request (each
 * invocation makes a handful of outbound requests to Ophardt on our behalf).
 */

import { scrapeOneCombo } from "../../lib/vmemScraper.mjs";

export default async function handler(req, res) {
  // ── auth ────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const { weapon, age, gender, season, nation } = req.query || {};
  if (!weapon || !age || !gender) {
    res.status(400).json({ error: "Missing required query params: weapon, age, gender" });
    return;
  }

  try {
    const result = await scrapeOneCombo({ weapon, age, gender, season });

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }

    const row = {
      weapon,
      age_category: age,
      gender: String(gender).toUpperCase(),
      nation: (nation || "SWE").toUpperCase(),
      season: result.season,
      source: "swe",
      scraped_at: result.scrapedAt,
      list: result.rankings,
      updated_at: new Date().toISOString(),
    };

    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/rankings_cache?on_conflict=weapon,age_category,gender,nation,season,source`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      throw new Error(`Supabase upsert failed: ${upsertRes.status} ${text}`);
    }

    res.status(200).json({
      ok: true,
      combo: `${weapon}-${age}-${gender}`,
      season: result.season,
      athletes: result.rankings.length,
    });
  } catch (err) {
    console.error(`[sync-rankings] ${weapon}-${age}-${gender}:`, err.message);
    res.status(500).json({ error: err.message });
  }
}
