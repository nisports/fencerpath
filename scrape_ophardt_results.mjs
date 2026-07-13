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
 *   node scrape_ophardt_results.mjs --event=32910 --direct
 *       Scrape results directly from the ophardt event page (for EC/WC events not in Swedish rankings).
 *       Add --gender=F to only fetch Women's results.
 *
 *   node scrape_ophardt_results.mjs --bio
 *       Scrape biography pages for all tracked fencers (reads ophardtAthleteId from fencerpath-real-data.json).
 *       Extracts ALL their competition results — including EC/WC that may not appear in Swedish rankings yet.
 *
 *   node scrape_ophardt_results.mjs --bio --match="European Championships"
 *       Same, but only include results from competitions whose name contains this string.
 *
 *   node scrape_ophardt_results.mjs --bio --after=2026-06-01
 *       Same, but only include results from competitions starting on or after this date.
 *
 *   node scrape_ophardt_results.mjs --bio --match="European Championships" --after=2026-06-01
 *       Combine filters.
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
const DIRECT    = !!args.direct;   // scrape directly from ophardt event page (for EC/WC)
const BIO_MODE  = !!args.bio;      // scrape biography pages for all tracked fencers
const BIO_MATCH = args.match || ""; // filter: comp name must contain this string
const BIO_AFTER = args.after || ""; // filter: comp start date must be >= this date (YYYY-MM-DD)
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
// "6/16/26" or "4/9/26" (biography page date) → "2026-06-16"
function parseMDY(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const yy = parseInt(m[3]);
  const yr = m[3].length === 2 ? (yy >= 70 ? 1900 + yy : 2000 + yy) : yy;
  return `${yr}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// "Sabre Men's U17 Individual" → {weapon, gender, age, team}
function parseCategoryLabel(s) {
  const t = decodeHtml(s).replace(/\s+/g, " ").trim();
  const team = /\bteam\b/i.test(t);
  let weapon = null, gender = null, age = null;
  if (/épée|epee/i.test(t))        weapon = "epee";
  else if (/\bfoil\b/i.test(t))    weapon = "foil";
  else if (/sabre|saber/i.test(t)) weapon = "sabre";
  if (/\bwomen\b|\bfemale\b/i.test(t))     gender = "W";
  else if (/\bmen\b|\bmale\b/i.test(t))    gender = "M";
  if      (/\bu11\b/i.test(t))  age = "u11";
  else if (/\bu13\b/i.test(t))  age = "u13";
  else if (/\bu15\b/i.test(t))  age = "u15";
  else if (/\bu17\b|\bcadet\b/i.test(t)) age = "u17";
  else if (/\bu20\b|\bjunior\b/i.test(t)) age = "u20";
  else if (/\bu23\b/i.test(t))  age = "u23";
  else if (/\bsenior\b/i.test(t)) age = "senior";
  else if (/\bveteran\b/i.test(t)) age = "veteran";
  return { weapon, gender, age, team };
}

// Split a row's HTML into cells by splitting on <td> openings.
// Handles the biography page's unclosed <td> tags (date cell has no </td>).
function splitRowCells(rowHtml) {
  const parts = rowHtml.split(/<td\b[^>]*>/);
  return parts.slice(1).map(p => p.replace(/<\/t[dr]>[\s\S]*$/, ""));
}

// Parse all results from a biography page HTML; return [{placement, startDate, city, compName, compId, category, weapon, gender, age, team}]
function parseBiographyPage(html) {
  const results = [];
  const anchor = html.indexOf('id="results"');
  if (anchor === -1) return results;
  const chunk = html.slice(anchor);

  // Parse each <tr> in every <tbody> inside the results section
  const tableRe = /<tbody>([\s\S]*?)<\/tbody>/g;
  let tm;
  while ((tm = tableRe.exec(chunk)) !== null) {
    const tbody = tm[1];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
    let rm;
    while ((rm = rowRe.exec(tbody)) !== null) {
      const cells = splitRowCells(rm[1]);
      if (cells.length < 4) continue;

      const placement = parseInt(stripTags(cells[0]).trim());
      if (isNaN(placement) || placement <= 0) continue;

      // Date cell may be unclosed — extract first M/D/YY pattern
      const dateM = stripTags(cells[1]).match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      const startDate = dateM ? parseMDY(dateM[1]) : null;

      // City + country from cells[2]
      const flagM   = cells[2].match(/title="([A-Z]{2,3})"/);
      const country = flagM ? flagM[1] : "";
      const cityM   = cells[2].match(/\/>\s*([^<>]+?)\s*<\/a>/);
      const city    = cityM ? stripTags(cityM[1]).trim() : "";

      // Competition name from cells[3]
      const compName = stripTags(cells[3]).trim();

      // results-competition ID
      const compIdM = (cells[2] + cells[3]).match(/results-competition\/(\d+)/);
      const compId  = compIdM ? compIdM[1] : null;

      // Category from cells[4]
      const category = cells.length >= 5 ? decodeHtml(cells[4]).replace(/\s+/g, " ").trim() : "";
      const cat = parseCategoryLabel(category);

      results.push({
        placement, startDate,
        city: city ? `${city}${country ? " (" + country + ")" : ""}` : "",
        compName, compId, category,
        ...cat,
      });
    }
  }
  return results;
}

// ---------- BIO MODE: scrape biography pages for tracked fencers ----------
async function scrapeBio() {
  // Load tracked fencers with ophardtAthleteId
  let fencers = [];
  try {
    const raw = await readFile(join(__dirname, "fencerpath-real-data.json"), "utf8");
    fencers = (JSON.parse(raw).fencers || []).filter(f => f.ophardtAthleteId);
  } catch (e) {
    console.error("✗ Could not read fencerpath-real-data.json:", e.message);
    process.exit(1);
  }
  if (!fencers.length) {
    console.error("✗ No fencers with ophardtAthleteId found in fencerpath-real-data.json");
    process.exit(1);
  }
  log(`\n→ Bio mode: ${fencers.length} fencer(s) with ophardtAthleteId`);
  if (BIO_MATCH) log(`  Filter: compName contains "${BIO_MATCH}"`);
  if (BIO_AFTER) log(`  Filter: startDate >= "${BIO_AFTER}"`);

  // For each fencer, fetch bio page and parse results
  // Group results by {weapon, age, gender, team} → athletes
  // Use a map key of "weapon|age|gender|team"
  const groups = new Map(); // key → {weapon,age,gender,team,athletes:[{name,nation,club,results}]}

  for (const f of fencers) {
    const url = `${BASE}/en/biography/athlete/${f.ophardtAthleteId}`;
    let html;
    try {
      html = await fetchHTML(url);
    } catch (e) {
      log(`  ⚠  Could not fetch bio for ${f.name}: ${e.message}`);
      await sleep(THROTTLE);
      continue;
    }

    let allResults = parseBiographyPage(html);
    log(`  ${f.name}: ${allResults.length} raw results`);

    // Apply filters
    if (BIO_MATCH) {
      allResults = allResults.filter(r => r.compName.toLowerCase().includes(BIO_MATCH.toLowerCase()));
    }
    if (BIO_AFTER) {
      allResults = allResults.filter(r => r.startDate && r.startDate >= BIO_AFTER);
    }

    log(`    → ${allResults.length} result(s) after filtering`);

    for (const r of allResults) {
      if (!r.weapon || !r.gender || !r.age) continue;
      const key = `${r.weapon}|${r.age}|${r.gender}|${r.team ? "team" : "ind"}`;
      if (!groups.has(key)) {
        groups.set(key, {
          weapon: r.weapon, age: r.age, gender: r.gender, team: r.team,
          season: SEASON,
          competitions: [],
          athletes: [],
        });
      }
      const grp = groups.get(key);

      // Track unique competitions
      if (!grp.competitions.find(c => c.compId === r.compId && c.name === r.compName)) {
        grp.competitions.push({ name: r.compName, date: r.startDate, compId: r.compId });
      }

      // Find or create athlete entry
      let ath = grp.athletes.find(a => a.name === f.name);
      if (!ath) {
        ath = {
          name: f.name,
          nation: f.nation || "SWE",
          club: f.club || "",
          results: [],
        };
        grp.athletes.push(ath);
      }
      ath.results.push({
        placement: r.placement,
        points: null,
        compName: r.compName,
        city: r.city,
        date: r.startDate,
        category: r.category,
      });
    }

    await sleep(THROTTLE);
  }

  const rankings = [...groups.values()];
  const totalAthletes = rankings.reduce((s, g) => s + g.athletes.length, 0);
  const totalResults  = rankings.reduce((s, g) => s + g.athletes.reduce((ss, a) => ss + a.results.length, 0), 0);

  if (!rankings.length) {
    log("\n✗ No results collected. Check --match / --after filters, or verify ophardtAthleteId values.");
    process.exit(1);
  }

  // Print summary
  log(`\n✓ Collected ${totalResults} result(s) across ${totalAthletes} fencer-group(s):`);
  for (const g of rankings) {
    log(`  · ${g.weapon}/${g.age}/${g.gender}${g.team ? "/team" : ""}: ${g.athletes.map(a => `${a.name}(${a.results.length})`).join(", ")}`);
  }

  const output = {
    scrapedAt: new Date().toISOString(),
    source:    "ophardt-bio",
    eventId:   null,
    season:    SEASON,
    rankings,
  };
  const outPath = join(__dirname, "ophardt_results.json");
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");
  log(`\n✓ Written: ${outPath}`);
  log(`\n→ Import in FencerPath: Settings → Sync from Ophardt → "Pick ophardt_results.json"`);
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

// ---------- direct event scraping (for EC/WC not in national rankings) ----------

// Parse the event overview page to find sub-competition result links.
// Ophardt event pages link to results via two patterns:
//   /en/search/results-mastercompetition/{masterCompId}   ← individual sub-event
//   /en/search/results/{eventId}                          ← whole-event combined page
function parseEventOverview(html, eventId) {
  const comps = [];
  const seenIds = new Set();

  // Primary pattern: results-mastercompetition links
  const mcRe = /\/en\/search\/results-mastercompetition\/(\d+)/g;
  let m;
  while ((m = mcRe.exec(html)) !== null) {
    if (!seenIds.has(m[1])) {
      seenIds.add(m[1]);
      comps.push({ id: m[1], urlType: "mastercomp" });
    }
  }

  // Secondary: whole-event results page
  if (html.includes(`/en/search/results/${eventId}`)) {
    if (!seenIds.has(`event-${eventId}`)) {
      seenIds.add(`event-${eventId}`);
      comps.push({ id: eventId, urlType: "event" });
    }
  }

  // Fallback: old /competition/{n} pattern (some events still use this)
  const compRe = new RegExp(`/widget/event/${eventId}/competition/(\\d+)`, "g");
  while ((m = compRe.exec(html)) !== null) {
    if (!seenIds.has(m[1])) {
      seenIds.add(m[1]);
      comps.push({ id: m[1], urlType: "widget" });
    }
  }

  // Try to enrich each mastercomp entry with weapon/age/gender from surrounding HTML
  // by scanning table rows that contain both a results-mastercompetition link and text labels
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const mcM = row.match(/\/results-mastercompetition\/(\d+)/);
    if (!mcM) continue;
    const entry = comps.find(c => c.id === mcM[1]);
    if (!entry) continue;

    const cellText = tdsOf(row).map(stripTags).join(" ").toLowerCase()
      + " " + stripTags(row).toLowerCase();

    if (!entry.weapon) {
      if (/épée|epee/.test(cellText))       entry.weapon = "epee";
      else if (/foil|fleuret/.test(cellText)) entry.weapon = "foil";
      else if (/saber|sabre/.test(cellText))  entry.weapon = "sabre";
    }
    if (!entry.gender) {
      if (/women|dames|kvinn|female/.test(cellText))      entry.gender = "W";
      else if (/\bmen\b|herr|\bmale\b/.test(cellText))    entry.gender = "M";
    }
    if (!entry.age) {
      const ageM = cellText.match(/\bu(\d+)\b|senior|veteran|cadet|junior/);
      if (ageM) entry.age = normAge(ageM[0]);
    }
    const dateM = row.match(/(\d{2}\.\d{2}\.\d{4})/);
    if (dateM && !entry.date) entry.date = parseDmY(dateM[1]);
  }

  return comps;
}

// Parse a direct ophardt competition result page.
// Returns [{ rank, name, nation, club, points }]
function parseDirectResultPage(html) {
  const athletes = [];

  // Strip modals first (same as ranking show pages)
  const clean = stripModals(html);

  // Try multiple table patterns:
  // 1. <table class="table ... rankingbody ...">
  // 2. any table with rank column
  const tablePatterns = [
    /<table[^>]*class="[^"]*ranking[^"]*"[^>]*>([\s\S]*?)<\/table>/,
    /<table[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/table>/,
    /<table[^>]*>([\s\S]*?)<\/table>/,
  ];

  let tableHtml = null;
  for (const pat of tablePatterns) {
    const tm = clean.match(pat);
    if (tm) { tableHtml = tm[0]; break; }
  }
  if (!tableHtml) return athletes;

  for (const row of rowsOf(tableHtml)) {
    // Rank cell — look for a number in the first <td>
    const cells = tdsOf(row);
    if (cells.length < 2) continue;

    const rankText = stripTags(cells[0]).trim();
    const rank = parseInt(rankText);
    if (!rank || rank > 9999) continue;

    // Name — look for athlete biography link or just the text
    let name = "";
    const nameM = row.match(/\/biography\/athlete\/\d+[^>]*>\s*([^<]+?)\s*<\/a>/);
    if (nameM) {
      name = stripTags(nameM[1]).trim();
    } else {
      // Fallback: second cell text
      name = stripTags(cells[1] || "").trim();
    }
    if (!name) continue;

    // Athlete ID
    const bioM = row.match(/\/biography\/athlete\/(\d+)/);
    const athleteId = bioM ? bioM[1] : null;

    // Nation — flag img src like /img/flags/swe.svg
    const flagM = row.match(/\/img\/flags\/([a-z]{3})\./);
    const nation = flagM ? flagM[1].toUpperCase() : null;

    // Points — look for decimal number in later cells
    let points = null;
    for (let i = 2; i < cells.length; i++) {
      const pt = parseFloat(stripTags(cells[i]));
      if (!isNaN(pt) && pt > 0) { points = pt; break; }
    }

    // Club — usually the cell after nation
    let club = "";
    if (cells.length >= 4) club = stripTags(cells[3] || "").trim();

    athletes.push({ rank, name, nation, club, points, athleteId });
  }

  return athletes;
}

// Fetch sub-competition label from its overview page (weapon/age/gender in page title or header)
function parseSubCompMeta(html) {
  const meta = { weapon: null, age: null, gender: null, name: null, date: null };

  // Look for page title / h1 / h2
  const titleM = html.match(/<title>([^<]+)<\/title>/) ||
                 html.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
                 html.match(/<h2[^>]*>([^<]+)<\/h2>/);
  if (titleM) {
    const t = stripTags(titleM[1]).toLowerCase();
    if (/épée|epee/.test(t)) meta.weapon = "epee";
    else if (/foil|fleuret/.test(t)) meta.weapon = "foil";
    else if (/saber|sabre/.test(t)) meta.weapon = "sabre";
    if (/women|dames|kvinn|female/.test(t)) meta.gender = "W";
    else if (/men|herr|male/.test(t)) meta.gender = "M";
    const ageM = t.match(/\bu(\d+)\b|senior|veteran|cadet|junior/);
    if (ageM) meta.age = normAge(ageM[0]);
    meta.name = stripTags(titleM[1]).trim();
  }

  // Date from page
  const dateM = html.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (dateM) meta.date = parseDmY(dateM[1]);

  return meta;
}

async function scrapeEventDirect(eventId, targetEvents) {
  const eventUrl = `${BASE}/en/widget/event/${eventId}`;
  log(`\n→ [direct] Fetching event overview: ${eventUrl}`);
  let eventHtml;
  try { eventHtml = await fetchHTML(eventUrl); }
  catch (e) { log(`✗ Could not fetch event page: ${e.message}`); return []; }

  // Extract sub-competition list
  const subComps = parseEventOverview(eventHtml, eventId);
  log(`  Found ${subComps.length} sub-competition link(s): ${subComps.map(c => `${c.urlType}/${c.id}`).join(", ")}`);

  if (!subComps.length) {
    log("  ✗ No result links found in event page.");
    return [];
  }

  const outputRankings = [];

  // If the only link is the whole-event page, fetch it and split by sub-headings
  const eventResultEntry = subComps.find(c => c.urlType === "event");
  const masterComps = subComps.filter(c => c.urlType === "mastercomp");

  // Prefer mastercomp entries (one result page per weapon/age/gender)
  const toProcess = masterComps.length ? masterComps : (eventResultEntry ? [eventResultEntry] : subComps);

  for (const sc of toProcess) {
    // Build the correct result URL based on type
    let resultUrl;
    if (sc.urlType === "mastercomp") {
      resultUrl = `${BASE}/en/search/results-mastercompetition/${sc.id}`;
    } else if (sc.urlType === "event") {
      resultUrl = `${BASE}/en/search/results/${eventId}`;
    } else {
      resultUrl = `${BASE}/en/widget/event/${eventId}/competition/${sc.id}/result`;
    }

    await sleep(THROTTLE);
    log(`→ GET ${resultUrl}`);
    let html;
    try { html = await fetchHTML(resultUrl); }
    catch (e) { log(`  ✗ Could not fetch: ${e.message}`); continue; }

    // Enrich metadata from page if not already known
    if (!sc.weapon || !sc.gender || !sc.age) {
      const pageMeta = parseSubCompMeta(html);
      sc.weapon = sc.weapon || pageMeta.weapon;
      sc.gender = sc.gender || pageMeta.gender;
      sc.age    = sc.age    || pageMeta.age;
      sc.date   = sc.date   || pageMeta.date;
      sc.name   = sc.name   || pageMeta.name;
    }

    // Apply CLI filters (after metadata is known)
    if (GENDER_IN && sc.gender && sc.gender !== GENDER_IN) { log(`  · skip ${sc.id} (gender mismatch)`); continue; }
    if (WEAPON_IN && sc.weapon && sc.weapon !== WEAPON_IN) { log(`  · skip ${sc.id} (weapon mismatch)`); continue; }
    if (AGE_IN    && sc.age    && sc.age    !== AGE_IN)    { log(`  · skip ${sc.id} (age mismatch)`);    continue; }

    // Filter by targetEvents weapon/age (if available)
    if (targetEvents.length && sc.weapon && sc.age) {
      const hit = targetEvents.find(t =>
        (!t.weapon      || t.weapon === sc.weapon) &&
        (!t.ageCategory || t.ageCategory === sc.age)
      );
      if (!hit) { log(`  · skip ${sc.id} (not in target competitions)`); continue; }
    }

    // If the event result page contains multiple sub-results, parse each section
    const athletes = parseDirectResultPage(html);
    if (!athletes.length) {
      log(`  ⚠  No result table found for ${sc.urlType}/${sc.id}`);
      continue;
    }

    const label = [sc.weapon, sc.age, sc.gender].filter(Boolean).join("/") || `id-${sc.id}`;
    log(`  ✓ ${label}: ${athletes.length} athlete(s)`);

    const evtName = sc.name || targetEvents[0]?.name || `Event ${eventId}`;
    const evtDate = sc.date || targetEvents[0]?.startDate || null;

    outputRankings.push({
      weapon: sc.weapon || WEAPON_IN || null,
      age:    sc.age    || AGE_IN    || null,
      gender: sc.gender || GENDER_IN || null,
      season: SEASON,
      competitions: [{ name: evtName, date: evtDate, masterCompId: String(sc.id) }],
      athletes: athletes.map(a => ({
        name:    a.name,
        nation:  a.nation,
        club:    a.club,
        results: [{
          placement: a.rank,
          points:    a.points ?? null,
          compName:  evtName,
          date:      evtDate,
        }],
      })),
    });
  }

  return outputRankings;
}

// ---------- load competitions.json ----------
async function loadCompsJson() {
  try {
    const raw = await readFile(join(__dirname, "competitions.json"), "utf8");
    const data = JSON.parse(raw);
    // Support both plain array and { competitions: [...] } wrapper
    return Array.isArray(data) ? data : (data.competitions || []);
  } catch {
    return [];
  }
}

// ---------- main ----------
async function main() {
  // ── BIO MODE: scrape biography pages for all tracked fencers ──────────────
  if (BIO_MODE) {
    await scrapeBio();
    return;
  }
  // ── END BIO MODE ──────────────────────────────────────────────────────────

  // 1. Resolve event info from competitions.json
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

  // ── DIRECT MODE: scrape the ophardt event page directly (EC/WC/EFC) ──────
  if (DIRECT) {
    if (!EVENT_ID) {
      console.error("✗ --direct requires --event=ID");
      process.exit(2);
    }
    const outputRankings = await scrapeEventDirect(EVENT_ID, targetEvents);
    if (!outputRankings.length) {
      log("\n✗ No results collected in direct mode.");
      log("  The event may not have published results yet, or the URL structure has changed.");
      log("  Try opening the event page manually: " + BASE + "/en/widget/event/" + EVENT_ID);
      process.exit(1);
    }
    const output = {
      scrapedAt: new Date().toISOString(),
      source:    "ophardt-event-direct",
      eventId:   EVENT_ID,
      season:    SEASON,
      rankings:  outputRankings,
    };
    const outPath = join(__dirname, "ophardt_results.json");
    await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");
    const totalAthletes = outputRankings.reduce((s, r) => s + r.athletes.length, 0);
    const totalResults  = outputRankings.reduce((s, r) => s + r.athletes.reduce((ss, a) => ss + a.results.length, 0), 0);
    log(`\n✓ Written: ${outPath}`);
    log(`  ${outputRankings.length} group(s), ${totalAthletes} athlete(s), ${totalResults} result(s)`);
    log(`\n→ Import in FencerPath: Settings → Sync from Ophardt → "Pick ophardt_results.json"`);
    return;
  }
  // ── END DIRECT MODE ───────────────────────────────────────────────────────

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
    log("  For EC/WC/EFC events, try: node scrape_ophardt_results.mjs --event=" + (EVENT_ID||"ID") + " --direct");
    log("  Or use the 🏅 button in FencerPath to log results manually.");
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
