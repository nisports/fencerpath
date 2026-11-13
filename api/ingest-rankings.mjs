/**
 * api/ingest-rankings.mjs
 *
 * Receives Svensk Ranking tables scraped by the FencerPath Ranking Sync browser
 * extension (extension/ in this repo) and upserts them into the shared Supabase
 * `rankings_cache` table.
 *
 * Why this exists: since ~2026-11-03 Ophardt serves a Cloudflare bot challenge
 * to non-browser clients, so api/cron/sync-rankings.mjs can no longer fetch the
 * ranking pages from Vercel. The extension runs inside Tina's real Chrome (which
 * has passed the challenge normally), fetches the 17 tables once a day, and
 * POSTs them here.
 *
 * POST /api/ingest-rankings
 *   Authorization: Bearer $INGEST_SECRET
 *   { season: "26/27", combos: [{ weapon, age, gender, scrapedAt, rankings: [{rank, points, name, rawName}] }] }
 *
 * Env: INGEST_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const WEAPONS = new Set(["epee", "foil", "sabre"]);
const AGES    = new Set(["senior", "u23", "u20", "u17", "u15", "u13", "u11", "veteran"]);

function validCombo(c) {
  if (!c || !WEAPONS.has(c.weapon) || !AGES.has(c.age) || !["M", "F"].includes(c.gender)) return false;
  if (!Array.isArray(c.rankings) || c.rankings.length === 0 || c.rankings.length > 2000) return false;
  return c.rankings.every(r =>
    Number.isInteger(r.rank) && r.rank > 0 &&
    typeof r.points === "number" && isFinite(r.points) &&
    typeof r.name === "string" && r.name.length > 0 && r.name.length < 120);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const secret = process.env.INGEST_SECRET;
  if (!secret || (req.headers["authorization"] || "") !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }

  const body   = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const season = String(body.season || "");
  if (!/^\d{2}\/\d{2}$/.test(season) || !Array.isArray(body.combos)) {
    res.status(400).json({ error: "Expected { season: 'YY/YY', combos: [...] }" });
    return;
  }

  const rows = [], rejected = [];
  for (const c of body.combos) {
    if (!validCombo(c)) { rejected.push(`${c?.weapon}-${c?.age}-${c?.gender}`); continue; }
    rows.push({
      weapon: c.weapon,
      age_category: c.age,
      gender: c.gender,
      nation: "SWE",
      season,
      source: "swe",
      scraped_at: c.scrapedAt || new Date().toISOString(),
      list: c.rankings.map(r => ({ rank: r.rank, points: r.points, name: r.name, rawName: r.rawName || r.name })),
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length) {
    const up = await fetch(`${supabaseUrl}/rest/v1/rankings_cache?on_conflict=weapon,age_category,gender,nation,season,source`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!up.ok) {
      res.status(502).json({ error: `Supabase upsert failed: ${up.status} ${await up.text()}` });
      return;
    }
  }

  res.status(200).json({ ok: true, season, saved: rows.length, rejected });
}
