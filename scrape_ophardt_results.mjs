#!/usr/bin/env node
/*
 * scrape_ophardt_results.mjs — Fetch individual competition results for tracked fencers.
 *
 * Uses Svenska Fäktförbundet ranking show pages (server-rendered HTML) to extract
 * per-athlete per-competition results: placement, points, competition name/date/city.
 *
 * Usage:
 *   node scrape_ophardt_results.mjs --event=33067
 *       Reads competitions.json, finds the event, scrapes results for all weapon/age combos.
 *
 *   node scrape_ophardt_results.mjs --event=33067 --gender=F
 *       Same, but only fetch Women's rankings.
 *
 *   node scrape_ophardt_results.mjs --weapon=epee --age=senior --gender=F
 *       Fetch all results for that weapon/age/gender (no event filter — full season sync).
 *
 *   node scrape_ophardt_results.mjs --event=33067 --all
 *       Include ALL competition results for matched athletes (not just the target event).
 *
 *   node scrape_ophardt_results.mjs --season=2025 --weapon=epee --age=u17 --gender=M
 *
 * Output: ophardt_results.json next to this script.
 *         Import into FencerPath via Settings → Sync from Ophardt → "Pick ophardt_results.json".
 *
 * Requires: Node 18+. No npm install.
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE      = "https://fencing.ophardt.online";
const FED_ID    = 3;  // Svenska Fäktförbundet

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const EVENT_ID  = args.event    || null;
const WEAPON_IN = (args.weapon  || "").toLowerCase();
const AGE_IN    = (args.age     || "").toLowerCase();
const GENDER_IN = (args.gender  || "").toUpperCase();
const SEASON    = args.season   || String(seasonStartYear(new Date()));
const ALL_COMPS = !!args.all;
const THROTTLE  = parseInt(args.throttle) || 400;
const QUIET     = !!args.quiet;
const log = (...a) => { if (!QUIET) console.error(...a); };

function seasonStartYear(d) {
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

// ---------- HTTP ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchHTML(url) {
  log("→ GET", url);
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; FencerPath results scraper; +https://fencerpath.se) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en,sv;q=0.8",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// ---------- HTML helpers ----------
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripTags(s) {
  return decodeHtml(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
function rowsOf(html) {
  return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
}
function tdsOf(html) {
  return [...String(html).matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => m[1]);
}
// "28.08.2025" or "28.08.2025." → "2025-08-28"
function parseDmY(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// ---------- weapon/age/gender mappings ----------
const WEAPON_TO_KEY = { Epee: "epee", "Épée": "epee", Foil: "foil", Sabre: "sabre" };
const GENDER_TO_KEY = { "Men's": "M", "Women's": "W", "Mixed": "X" };
const AGE_OPHARDT_MAP = {
  u11: "U11", u13: "U13", u15: "U15", u17: "U17",
  u20: "U20", u23: "U23", senior: "Senior", veteran: "Veteran",
};
// Normalise Ophardt age strings like "U17", "Senior", "Juniorer" to our codes
const AGE_NORM = {
  u11: "u11", u13: "u13", u15: "u15", u17: "u17", u20: "u20", u23: "u23",
  senior: "senior", seniors: "senior", seniorer: "senior",
  junior: "u20", juniors: "u20", juniorer: "u20",
  cadet: "u17", cadets: "u17", kadett: "u17", kadetter: "u17",
  veteran: "veteran",
};
function normAge(s) {
  const t = String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return AGE_NORM[t] || s.toLowerCase();
}

// ---------- strip modal divs (needed before parsing ranking table) ----------
function stripModals(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const m = html.slice(i).match(/<div class="modal[^"]*"/);
    if (!m) { out += html.slice(i); break; }
    out += html.slice(i, i + m.index);
    let pos = i + m.index;
    let depth = 0;
    const re = /<\/?div\b[^>]*>/g;
    re.lastIndex = pos;
    let endPos = -1;
    let mm;
    while ((mm = re.exec(html)) !== null) {
      if (mm[0].startsWith("</")) depth--;
      else depth++;
      if (depth === 0) { endPos = mm.index + mm[0].length; break; }
    }
    if (endPos < 0) { out += html.slice(pos); break; }
    i = endPos;
  }
  return out;
}

// ---------- parse federation ranking index page ----------
// Returns [{ id, ageclass, weapon, gender, type }]
function parseIndexPage(html) {
  const entries = [];
  const cardRe = /<div class="card">\s*<div class="card-header[^>]*>([\s\S]*?)<\/div>\s*<div class="card-body">([\s\S]*?)<\/div>\s*<\/div>/g;
  let cm;
  while ((cm = cardRe.exec(html)) !== null) {
    const title = stripTags(cm[1]);
    const body  = cm[2];
    const tableM = body.match(/<table[^>]*>([\s\S]*?)<\/table>/);
    if (!tableM) continue;
    const trs = rowsOf(tableM[1]);
    // Weapon column order: M-Epee, M-Foil, M-Sabre, W-Epee, W-Foil, W-Sabre
    const weaponCols = [];
    if (trs[1]) {
      for (const wm of trs[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)) {
        const w = stripTags(wm[1]);
        if (WEAPON_TO_KEY[w]) weaponCols.push(WEAPON_TO_KEY[w]);
      }
    }
    const colMeta = weaponCols.map((w, i) => ({ weapon: w, gender: i < 3 ? "M" : "W" }));
    for (const r of trs.slice(2)) {
      const ageM = r.match(/<th[^>]*>\s*([^<\s][^<]*?)\s*<\/th>/);
      const ageclass = ageM ? normAge(stripTags(ageM[1])) : "?";
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
      for (let i = 0; i < cells.length && i < colMeta.length; i++) {
        const linkM = cells[i].match(/href="[^"]*\/rankings\/show\/(\d+)"/);
        if (!linkM) continue;
        entries.push({
          id:       +linkM[1],
          type:     title,
          ageclass,
          weapon:   colMeta[i].weapon,
          gender:   colMeta[i].gender,
        });
      }
    }
  }
  return entries;
}

// ---------- parse a single ranking show page ----------
// Returns { meta, competitions: [...], athletes: [...] }
function parseShowPage(html, rankingId) {
  const out = { id: +rankingId || null, meta: {}, competitions: [], athletes: [] };

  // --- Competition list (with ophardtCompId, name, date, city) ---
  const allcompM = html.match(/<h3[^>]*>\s*<a name="allcomp">[\s\S]*?<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/);
  if (allcompM) {
    for (const r of rowsOf(allcompM[1]).slice(1)) {
      const cells = tdsOf(r);
      if (cells.length < 6) continue;
      const anchorM = r.match(/<a name="comp-(\d+)"/);
      const id = anchorM ? +anchorM[1] : null;
      const nationCell = stripTags(cells[4] || "");
      const nation = nationCell.match(/[A-Z]{3}$/)?.[0] || nationCell;
      out.competitions.push({
        ophardtCompId: id,
        name:      stripTags(cells[2] || ""),
        city:      stripTags(cells[3] || ""),
        nation,
        startDate: parseDmY(stripTags(cells[5] || "")),
        endDate:   parseDmY(stripTags(cells[6] || "")),
        ageclass:  stripTags(cells[7] || ""),
      });
    }
  }

  // --- Per-athlete modal detail breakdown (placement per competition) ---
  const detailByAthlete = {};
  const modalRe = /<div class="modal fade" id="info-(\d+)"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/g;
  let modalMatch;
  while ((modalMatch = modalRe.exec(html)) !== null) {
    const athleteId = modalMatch[1];
    const details = [];
    for (const r of rowsOf(modalMatch[2])) {
      const tds = tdsOf(r).map(stripTags);
      if (tds.length < 5) continue;
      if (/^Rank$/i.test(tds[0])) continue;
      const placement = parseInt(tds[0]);
      if (!placement) continue;
      details.push({
        placement,
        points:   parseFloat(tds[1]) || null,
        compName: tds[2],
        city:     tds[3],
        date:     parseDmY(tds[4]),
      });
    }
    if (details.length) detailByAthlete[athleteId] = details;
  }

  // --- Athlete ranking table (after stripping modals so regex is clean) ---
  const cleanHtml = stripModals(html);
  const bodyTableM = cleanHtml.match(/<table class="table table-striped table-sm rankingbody[^"]*"[\s\S]*?<\/table>/);
  if (bodyTableM) {
    for (const r of rowsOf(bodyTableM[0])) {
      const rankM = r.match(/<td class="ranking">(\d+)<\/td>/);
      if (!rankM) continue;
      const rank = +rankM[1];

      const nameM = r.match(/aria-haspopup="true"[^>]*>\s*([^<]+?)\s*<\/a>/);
      const name  = nameM ? stripTags(nameM[1]) : "";
      if (!name) continue;

      const bioM      = r.match(/\/biography\/athlete\/(\d+)/);
      const athleteId = bioM ? bioM[1] : null;

      const flagM  = [...r.matchAll(/\/img\/flags\/([a-z]{3})\.(?:svg|jpg|png)/g)];
      const nation = flagM[0] ? flagM[0][1].toUpperCase() : null;

      const clubM = r.match(/<td class="ranking rankingclub">([\s\S]*?)<\/td>/);
      const club  = clubM ? stripTags(clubM[1]) : "";

      const totalTds = [...r.matchAll(/<td class="ranking">(\d+)<\/td>/g)];
      const points   = totalTds[1] ? +totalTds[1][1] : null;

      const results = athleteId && detailByAthlete[athleteId]
        ? detailByAthlete[athleteId]
        : [];

      out.athletes.push({ rank, name, nation, club, points, athleteId, results });
    }
  }
  return out;
}

// ---------- name similarity (for event matching) ----------
function normStr(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function eventSimilarity(compName, compDate, targetName, targetDate) {
  // Token overlap
  const toks   = normStr(targetName).split(" ").filter(t => t.length > 2);
  const normC  = normStr(compName);
  const nameScore = toks.length
    ? toks.filter(t => normC.includes(t)).length / toks.length
    : 0;
  // Date proximity
  let dateScore = 0;
  if (compDate && targetDate) {
    const diff = Math.abs(new Date(compDate) - new Date(targetDate)) / 86400000;
    if (diff <= 7) dateScore = 1 - diff / 7;
  }
  return nameScore * 0.6 + dateScore * 0.4;
}

// ---------- load competitions.json ----------
async function loadCompsJson() {
  try {
    const raw = await readFile(join(__dirname, "competitions.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ---------- main ----------
async function main() {
  // 1. Resolve event info
  let targetEvents = []; // [{name, startDate, weapon, ageCategory}]
  if (EVENT_ID) {
    const comps = await loadCompsJson();
    const matches = comps.filter(c => String(c.eventId) === String(EVENT_ID));
    if (!matches.length) {
      log(`⚠  event ${EVENT_ID} not found in competitions.json — using weapon/age/gender args only`);
    } else {
      log(`✓ Found ${matches.length} competition record(s) for eventId=${EVENT_ID}:`);
      matches.forEach(c => log(`  · ${c.name} (${c.weapon}/${c.ageCategory}) on ${c.startDate}`));
      targetEvents = matches.map(c => ({
        name: c.name, startDate: c.startDate, weapon: c.weapon, ageCategory: c.ageCategory,
      }));
    }
  }

  // 2. Build (weapon, age, gender, season) combos to fetch
  // Collect unique weapon+age combos from target events, then cross with gender
  let combos = [];
  if (targetEvents.length) {
    const pairs = [...new Set(targetEvents.map(e => `${e.weapon}|${e.ageCategory}`))];
    for (const pair of pairs) {
      const [weapon, age] = pair.split("|");
      const genders = GENDER_IN ? [GENDER_IN] : ["M", "W"];
      for (const gender of genders) {
        combos.push({ weapon: WEAPON_IN || weapon, age: AGE_IN || age, gender, season: SEASON });
      }
    }
  } else if (WEAPON_IN && AGE_IN) {
    const genders = GENDER_IN ? [GENDER_IN] : ["M", "W"];
    for (const g of genders) {
      combos.push({ weapon: WEAPON_IN, age: AGE_IN, gender: g, season: SEASON });
    }
  } else {
    console.error("✗ Provide --event=ID or both --weapon=... and --age=...");
    console.error("  Example: node scrape_ophardt_results.mjs --event=33067");
    console.error("  Example: node scrape_ophardt_results.mjs --weapon=epee --age=senior --gender=F");
    process.exit(2);
  }

  log(`\n→ Fetching ranking index (federation ${FED_ID}, season ${SEASON})…`);
  const indexHtml = await fetchHTML(`${BASE}/en/search/rankings/${FED_ID}?season=${SEASON}`);
  const indexEntries = parseIndexPage(indexHtml);
  log(`  Found ${indexEntries.length} ranking entries in index`);

  // 3. For each combo, find matching show page IDs in the index
  const toFetch = []; // [{weapon, age, gender, season, rankingId, type}]
  for (const combo of combos) {
    const matches = indexEntries.filter(e =>
      e.weapon === combo.weapon &&
      normAge(e.ageclass) === combo.age &&
      e.gender === combo.gender
    );
    if (!matches.length) {
      log(`  ⚠  No ranking found for ${combo.weapon}/${combo.age}/${combo.gender} season ${combo.season}`);
      continue;
    }
    for (const m of matches) {
      toFetch.push({ ...combo, rankingId: m.id, type: m.type });
    }
  }

  if (!toFetch.length) {
    log("✗ No matching rankings found. Try adjusting --weapon, --age, --gender, or --season.");
    process.exit(1);
  }
  log(`\n→ Will fetch ${toFetch.length} show page(s):`);
  toFetch.forEach(f => log(`  · ${f.type} ${f.weapon}/${f.age}/${f.gender} → /show/${f.rankingId}`));

  // 4. Fetch each show page and collect results
  const outputRankings = [];

  for (const item of toFetch) {
    await sleep(THROTTLE);
    const url  = `${BASE}/en/search/rankings/show/${item.rankingId}`;
    let html;
    try { html = await fetchHTML(url); }
    catch (e) { log(`  ✗ Failed: ${e.message}`); continue; }

    const parsed = parseShowPage(html, item.rankingId);
    log(`  ✓ ${item.weapon}/${item.age}/${item.gender}: ${parsed.athletes.length} athletes, ${parsed.competitions.length} competitions`);

    // 5. Filter athlete results to target event only (unless --all)
    let athletes;
    if (ALL_COMPS || !targetEvents.length) {
      // Keep all results
      athletes = parsed.athletes
        .filter(a => a.results && a.results.length > 0)
        .map(a => ({ name: a.name, nation: a.nation, club: a.club, results: a.results }));
    } else {
      // Find the best-matching competition in the show page for each target event
      const targetMatches = new Map(); // ophardtCompId or date+name key → true
      for (const tgt of targetEvents) {
        if (tgt.weapon !== item.weapon && WEAPON_IN !== item.weapon) continue;
        // Scan competitions list for the show page
        let bestComp = null, bestScore = -1;
        for (const c of parsed.competitions) {
          const score = eventSimilarity(c.name, c.startDate, tgt.name, tgt.startDate);
          if (score > bestScore) { bestScore = score; bestComp = c; }
        }
        if (bestComp && bestScore >= 0.3) {
          log(`    ↳ Matched target event: "${bestComp.name}" on ${bestComp.startDate} (score ${bestScore.toFixed(2)})`);
          // Mark by ophardtCompId and by date+name for modal matching
          if (bestComp.ophardtCompId) targetMatches.set("id:" + bestComp.ophardtCompId, true);
          if (bestComp.startDate)     targetMatches.set("date:" + bestComp.startDate, true);
          if (bestComp.name)          targetMatches.set("name:" + normStr(bestComp.name), true);
        } else {
          // Fall back: match by date only from modal results
          if (tgt.startDate) targetMatches.set("date:" + tgt.startDate, true);
          log(`    ⚠  Couldn't match "${tgt.name}" in competitions list — will match by date ${tgt.startDate}`);
        }
      }

      athletes = parsed.athletes
        .map(a => {
          const filtered = (a.results || []).filter(r => {
            if (targetMatches.has("date:" + r.date)) return true;
            const rNorm = normStr(r.compName);
            for (const [k] of targetMatches) {
              if (k.startsWith("name:") && rNorm.includes(k.slice(5))) return true;
            }
            return false;
          });
          return filtered.length ? { name: a.name, nation: a.nation, club: a.club, results: filtered } : null;
        })
        .filter(Boolean);
    }

    if (!athletes.length) {
      log(`    ⚠  No results for target event found in this ranking`);
      continue;
    }
    log(`    ✓ ${athletes.length} athlete(s) with results at target event`);

    // Build competitions list for output (only referenced ones)
    const referencedNames = new Set(athletes.flatMap(a => a.results.map(r => normStr(r.compName))));
    const competitions = parsed.competitions
      .filter(c => referencedNames.has(normStr(c.name)))
      .map(c => ({
        name: c.name,
        date: c.startDate,
        city: c.city,
        masterCompId: c.ophardtCompId ? String(c.ophardtCompId) : undefined,
      }));

    outputRankings.push({
      weapon: item.weapon,
      age:    item.age,
      gender: item.gender,
      season: item.season,
      competitions,
      athletes,
    });
  }

  if (!outputRankings.length) {
    log("\n✗ No results collected. The target event may not be tracked in the Swedish ranking system.");
    log("  For results not in the national ranking, use the 🏅 button in FencerPath to log manually.");
    process.exit(1);
  }

  // 6. Write output
  const output = {
    scrapedAt: new Date().toISOString(),
    source:    "ophardt-rankings",
    eventId:   EVENT_ID || null,
    season:    SEASON,
    rankings:  outputRankings,
  };

  const outPath = join(__dirname, "ophardt_results.json");
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  // Summary
  const totalAthletes = outputRankings.reduce((s, r) => s + r.athletes.length, 0);
  const totalResults  = outputRankings.reduce((s, r) =>
    s + r.athletes.reduce((ss, a) => ss + a.results.length, 0), 0);
  log(`\n✓ Written: ${outPath}`);
  log(`  ${outputRankings.length} ranking group(s), ${totalAthletes} athlete(s), ${totalResults} result(s)`);
  log(`\n→ Import in FencerPath: Settings → Sync from Ophardt → "Pick ophardt_results.json"`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
