#!/usr/bin/env node
/*
 * scrape_ophardt_rankings.mjs — Pull a national/Nordic/EFC/FIE ranking table
 * from fencing.ophardt.online and write rankings.json next to this script.
 *
 * The Ophardt rankings URL takes parameters like:
 *   /en/search/rankings?nation=SWE&ageclass=u17&discipline=epee&gender=M&season=2025
 * (parameter names may differ; this script is robust to that — it tries
 *  several known variations and saves the raw HTML on failure for inspection.)
 *
 * Usage:
 *   node scrape_ophardt_rankings.mjs --nation=SWE --age=senior --weapon=epee --gender=M
 *   node scrape_ophardt_rankings.mjs --nation=SWE --age=u17 --weapon=foil --gender=W --season=2025
 *
 * Required: at least --age and --weapon. Defaults: nation=SWE, gender=M, season=current
 *
 * Output: rankings.json — { scrapedAt, filters, rankings:[{rank,name,club,nation,points,license}] }
 *
 * Requires: Node 18+. No npm install.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const NATION = args.nation || "SWE";
const AGE = args.age || args.ageclass; // u11/u13/u15/u17/u20/u23/senior/veteran
const WEAPON = args.weapon || args.discipline; // epee/foil/sabre
const GENDER = (args.gender || "M").toUpperCase(); // M / W / F
const SEASON = args.season || (new Date().getFullYear()).toString();
const QUIET = !!args.quiet;
const log = (...a) => { if (!QUIET) console.log(...a); };

if (!AGE || !WEAPON) {
  console.error("✗ Missing required --age and --weapon. Example:\n" +
    "   node scrape_ophardt_rankings.mjs --nation=SWE --age=senior --weapon=epee --gender=M");
  process.exit(2);
}

// Map age codes to typical Ophardt URL values (best effort)
const AGE_URL = {
  u11:"u11", u13:"u13", u15:"u15", u17:"u17", u20:"u20", u23:"u23",
  senior:"senior", veteran:"veteran"
}[AGE.toLowerCase()] || AGE;

const GENDER_URL = GENDER === "F" ? "W" : GENDER;

// Try a sequence of plausible URLs (Ophardt has changed param names over time)
const URLS = [
  `https://fencing.ophardt.online/en/search/rankings?nation=${NATION}&ageclass=${AGE_URL}&discipline=${WEAPON}&gender=${GENDER_URL}&season=${SEASON}`,
  `https://fencing.ophardt.online/en/search/rankings?nation=${NATION}&ageclass=${AGE_URL}&weapon=${WEAPON}&gender=${GENDER_URL}&season=${SEASON}`,
  `https://fencing.ophardt.online/en/ranking/national?nation=${NATION}&ageclass=${AGE_URL}&discipline=${WEAPON}&gender=${GENDER_URL}&season=${SEASON}`,
];

// ---------- fetch ----------
async function fetchHTML(url) {
  log("→ GET", url);
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; FencerPath ranking scraper; +https://fencerpath.se) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en,sv;q=0.8",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

// ---------- parse ----------
function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) { return decodeHtml(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

function parseRankingTable(html) {
  // Try every <table> on the page; return the one whose header looks like a ranking
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)].map(m => m[0]);
  for (const tbl of tables) {
    const headerMatch = tbl.match(/<thead[\s\S]*?<\/thead>/i) || tbl.match(/<tr[\s\S]*?<\/tr>/i);
    const headerText = headerMatch ? stripTags(headerMatch[0]).toLowerCase() : "";
    // Heuristic: a ranking table has both a "rank/place" column and a "name/athlete/fencer" column
    const looksRanking = /(rank|place|position|plats)/.test(headerText) &&
      /(name|athlete|fencer|namn|fäktare)/.test(headerText);
    if (!looksRanking) continue;

    // Map column names by header position
    const heads = (tbl.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "")
      .match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)?.map(c => stripTags(c).toLowerCase()) || [];
    const colIdx = name => heads.findIndex(h => name.test(h));
    const idx = {
      rank:    colIdx(/^(rank|place|pos|plats|nr|#)$/i)        ?? 0,
      name:    colIdx(/^(name|athlete|fencer|namn|fäktare)$/i) ?? 1,
      club:    colIdx(/^(club|klubb)$/i),
      nation:  colIdx(/^(nation|land)$/i),
      points:  colIdx(/^(points|pts|po[äa]ng)$/i),
      license: colIdx(/^(license|lic|licens|id)$/i),
    };

    const rows = [];
    const tbody = tbl.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || tbl;
    const rs = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
    for (const r of rs) {
      const cells = [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => stripTags(m[1]));
      if (cells.length < 2) continue;
      // Skip the header row that may also live in tbody
      if (/(rank|place|name|namn)/i.test(cells[0]) && /(name|namn|athlete)/i.test(cells[1] || "")) continue;
      const get = i => i != null && i >= 0 ? cells[i] || "" : "";
      const rank = parseInt(get(idx.rank)); if (!rank) continue;
      rows.push({
        rank,
        name: get(idx.name),
        club: get(idx.club),
        nation: get(idx.nation),
        points: parseFloat(get(idx.points).replace(",", ".")) || null,
        license: get(idx.license),
      });
    }
    if (rows.length > 0) return { headers: heads, rows };
  }
  return null;
}

// ---------- main ----------
async function main() {
  log(`Rankings: nation=${NATION} age=${AGE} weapon=${WEAPON} gender=${GENDER} season=${SEASON}`);

  let parsed = null, lastUrl = null, lastHtml = null;
  for (const url of URLS) {
    try {
      const html = await fetchHTML(url);
      lastUrl = url; lastHtml = html;
      parsed = parseRankingTable(html);
      if (parsed) { log(`✓ Parsed ${parsed.rows.length} rows from ${url}`); break; }
      else log(`  (no ranking table at this URL — trying next)`);
    } catch (e) {
      log(`  ${e.message}`);
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));

  if (!parsed) {
    // Save raw HTML for diagnosis
    const dump = join(here, `rankings_debug_${Date.now()}.html`);
    if (lastHtml) await writeFile(dump, lastHtml);
    console.error("✗ Could not find a ranking table. Saved last HTML to:", dump);
    console.error("  Send that file back to refine the parser.");
    process.exit(1);
  }

  const out = {
    scrapedAt: new Date().toISOString(),
    source: "fencing.ophardt.online",
    sourceUrl: lastUrl,
    filters: { nation: NATION, age: AGE, weapon: WEAPON, gender: GENDER, season: SEASON },
    headers: parsed.headers,
    count: parsed.rows.length,
    rankings: parsed.rows,
  };
  const outPath = join(here, "rankings.json");
  await writeFile(outPath, JSON.stringify(out, null, 2));
  log(`✓ Wrote ${parsed.rows.length} rankings to ${outPath}`);
  log(`  top 3:`, parsed.rows.slice(0, 3).map(r => `${r.rank}. ${r.name}${r.points ? " ("+r.points+"p)" : ""}`));
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
