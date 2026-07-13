#!/usr/bin/env node
/*
 * scrape_ophardt_swe_rankings.mjs
 *
 * Scrape Svenska Fäktförbundet rankings from Ophardt Online.
 * Two-pass:
 *   1. Index page  /en/search/rankings/{fedId}?season=YYYY
 *      → catalog of all rankings (Masters / Nationell / Uttagning VM/EM)
 *        × age × weapon × gender, each with a numeric ID.
 *   2. Show pages  /en/search/rankings/show/{rankingId}
 *      → metadata + qualifying competitions list + ranked athletes
 *        with per-competition score breakdown.
 *
 * Usage:
 *   node scrape_ophardt_swe_rankings.mjs                   # default: SWE, current season,
 *                                                          #          VM/EM rankings only
 *   node scrape_ophardt_swe_rankings.mjs --season=2024     # 2024/2025 season
 *   node scrape_ophardt_swe_rankings.mjs --type=all        # also Masters + Nationell
 *   node scrape_ophardt_swe_rankings.mjs --type=vm-em      # only Uttagning VM/EM (default)
 *   node scrape_ophardt_swe_rankings.mjs --type=index      # just the catalog, no show pages
 *   node scrape_ophardt_swe_rankings.mjs --id=21642        # fetch one specific show page
 *   node scrape_ophardt_swe_rankings.mjs --fed=3           # federation id (3 = SWE)
 *   node scrape_ophardt_swe_rankings.mjs --throttle=400    # ms between detail fetches
 *
 * Output: swe_rankings.json next to this script.
 *
 * Requires: Node 18+. No npm install.
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const FED        = args.fed    || "3";        // 3 = Svenska Fäktförbundet
const SEASON     = args.season || String(seasonStartYear(new Date()));
const TYPE       = args.type   || "vm-em";    // "vm-em" | "all" | "index" | "national" | "masters"
const ONLY_ID    = args.id     || null;
const THROTTLE   = parseInt(args.throttle) || 400;
const QUIET      = !!args.quiet;
const LOCAL_FILE = args.local  || null;       // for offline testing against a saved HTML
const log = (...a) => { if (!QUIET) console.log(...a); };

function seasonStartYear(d) {
  // Aug 1 → next Jul 31 is one season; "2025" = 2025/2026 season
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

// ---------- HTTP ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchHTML(url) {
  if (LOCAL_FILE) return readFile(LOCAL_FILE, "utf8");
  log("→ GET", url);
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; FencerPath SWE-ranking scraper; +https://fencerpath.se) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en,sv;q=0.8",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

// ---------- HTML helpers ----------
function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#0*39;/g, "'").replace(/&#0*160;/g, " ")
          .replace(/&nbsp;/g, " ");
}
/** Strip all nested <div class="modal ...">...</div> blocks from HTML.
 *  Handles nested divs by walking carefully with depth tracking. */
function stripModals(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const m = html.slice(i).match(/<div class="modal[^"]*"/);
    if (!m) { out += html.slice(i); break; }
    const startInRel = m.index;
    out += html.slice(i, i + startInRel);
    // Walk forward tracking depth of <div>
    let pos = i + startInRel;
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
function stripTags(s) { return decodeHtml(String(s||"").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }
function tdText(html) {
  // Get clean text of a single <td>...</td> block content
  return stripTags(html);
}
function rowsOf(tableHtml) {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
}
function tdsOf(rowHtml) {
  return [...rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => m[1]);
}

// Parse date strings like "28.08.2025" → "2025-08-28"
function parseDmY(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
}

const WEAPON_TO_KEY = { Epee:"epee", "Épée":"epee", Foil:"foil", Sabre:"sabre" };
const GENDER_TO_KEY = { "Men's":"M", "Women's":"W", "Mixed":"X" };

// ---------- Index page parser ----------
/**
 * Parse the index page (one federation × one season).
 * Returns { season, fedName, categories: { Masters: [...], 'Nationell Ranking': [...],
 *           'Uttagning VM/EM': [...] } }
 * Each entry: { id, type, ageclass, weapon, gender, label }
 */
function parseIndexPage(html) {
  const out = { season: null, fedName: null, categories: {} };

  // Federation name from h1
  const h1m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (h1m) {
    const txt = stripTags(h1m[1]);
    const m = txt.match(/Rankings:\s*(.+)$/);
    out.fedName = m ? m[1] : txt;
  }

  // Active season
  const seasonM = html.match(/<option[^>]*value="(\d{4})"[^>]*selected[^>]*>([^<]+)/);
  if (seasonM) out.season = seasonM[1];

  // Each .card has a header ("Masters" / "Nationell Ranking" / "Uttagning VM/EM") and a table inside
  const cardRe = /<div class="card">\s*<div class="card-header[^>]*>([\s\S]*?)<\/div>\s*<div class="card-body">([\s\S]*?)<\/div>\s*<\/div>/g;
  let cm;
  while ((cm = cardRe.exec(html)) !== null) {
    const title = stripTags(cm[1]);
    const body = cm[2];
    const tableM = body.match(/<table[^>]*>([\s\S]*?)<\/table>/);
    if (!tableM) continue;
    const table = tableM[1];

    // Header: figure out weapon order for Men's then Women's
    const headRows = [...table.matchAll(/<thead[\s\S]*?<\/thead>|<tr>([\s\S]*?)<\/tr>/g)];
    // Simpler: just take the second <tr> in the table head (weapon labels in order)
    const trs = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
    // The first 2 rows are header rows; from row 2 we get the 6 weapon columns
    const weaponCols = [];
    if (trs[1]) {
      for (const wm of trs[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)) {
        const w = stripTags(wm[1]);
        if (WEAPON_TO_KEY[w]) weaponCols.push(WEAPON_TO_KEY[w]);
      }
    }
    // Genders in order: first 3 weapons = Men's, next 3 = Women's
    const colMeta = weaponCols.map((w, i) => ({ weapon: w, gender: i < 3 ? "M" : "W" }));

    const entries = [];
    // Data rows (skip the header rows)
    for (const r of trs.slice(2)) {
      const ageMatch = r.match(/<th[^>]*>\s*([^<\s][^<]*?)\s*<\/th>/);
      const ageclass = ageMatch ? stripTags(ageMatch[1]) : "?";
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
      for (let i = 0; i < cells.length && i < colMeta.length; i++) {
        const cell = cells[i];
        const linkM = cell.match(/href="[^"]*\/rankings\/show\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!linkM) continue;
        const id = +linkM[1];
        const label = stripTags(linkM[2]);
        entries.push({
          id, type: title, ageclass, weapon: colMeta[i].weapon, gender: colMeta[i].gender, label
        });
      }
    }
    out.categories[title] = entries;
  }
  return out;
}

// ---------- Show page parser ----------
/**
 * Parse a single ranking detail page. Returns:
 * { id, meta:{title, weapon, gender, ageclass, category, calculatedOn, yobRange, rankingType, nationType},
 *   competitions: [{ ophardtCompId, name, city, country, startDate, endDate, ageclass,
 *                    group, pointkey, nations, multiplicator, sum, sameFederation }, ...],
 *   athletes: [{ rank, points, transferredPoints, name, athleteId, nation, club, yob,
 *                results: [{ ophardtCompId, placement, points }, ...] }, ...] }
 */
function parseShowPage(html, rankingId) {
  const out = { id: +rankingId || null, meta: {}, competitions: [], athletes: [] };

  // --- H1: "Uttagning VM/EM: 2025"
  const h1m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (h1m) out.meta.title = stripTags(h1m[1]);

  // --- Header metadata (the first <table> after h1 with 4 cols header — Discipline/Gender/Ageclass/Category/Calculated on)
  const ranking_header_table = html.match(/<table class="table table-striped table[^"]*"[\s\S]*?<\/table>/);
  if (ranking_header_table) {
    const headerRows = rowsOf(ranking_header_table[0]);
    // First TR is column headers; second TR is values. Then third TR is more headers; fourth TR is values.
    if (headerRows[1]) {
      const c = tdsOf(headerRows[1]).map(stripTags);
      out.meta.weapon     = WEAPON_TO_KEY[c[0]] || c[0];
      out.meta.gender     = GENDER_TO_KEY[c[1]] || c[1];
      out.meta.ageclass   = c[2];
      out.meta.category   = c[3];           // "Individual" | "Team"
      out.meta.calculatedOn = c[4];         // "03.05.2026. 14:47"
    }
    if (headerRows[3]) {
      const c = tdsOf(headerRows[3]).map(stripTags);
      out.meta.yobRange       = c[0];
      out.meta.rankingType    = c[1];
      out.meta.nationType     = c[2];
      out.meta.samePoints     = c[3];
      out.meta.transferredPts = c[4];
    }
  }

  // --- "all assigned competitions" section ---
  const allcompM = html.match(/<h3[^>]*>\s*<a name="allcomp">[\s\S]*?<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/);
  if (allcompM) {
    const compRows = rowsOf(allcompM[1]).slice(1); // skip header
    for (const r of compRows) {
      const cells = tdsOf(r);
      if (cells.length < 10) continue;
      // Anchor name has the competition id: <a name="comp-{id}" ...>
      const anchorM = r.match(/<a name="comp-(\d+)"/);
      const id = anchorM ? +anchorM[1] : null;
      // Cell layout (0-indexed):
      //   0: row number
      //   1: dropdown with links (we don't need it)
      //   2: Title
      //   3: City
      //   4: Nation (flag + code)
      //   5: start Date
      //   6: end Date
      //   7: Ageclass
      //   8: Group
      //   9: Pointkey
      //  10: Nations entry count
      //  11: Multiplicator
      //  12: Replaced (often empty)
      //  13: Deleted (often empty)
      //  14: Sum
      //  15: Same federation
      const nationCell = stripTags(cells[4]);
      const nation = nationCell.match(/[A-Z]{3}$/)?.[0] || nationCell;
      out.competitions.push({
        ophardtCompId: id,
        name: stripTags(cells[2]),
        city: stripTags(cells[3]),
        nation,
        startDate: parseDmY(stripTags(cells[5])),
        endDate:   parseDmY(stripTags(cells[6])),
        ageclass:  stripTags(cells[7]),
        group:     stripTags(cells[8]),
        pointkey:  stripTags(cells[9]),
        nations:   stripTags(cells[10]),
        multiplicator: parseFloat(stripTags(cells[11])) || null,
        replaced:  stripTags(cells[12]) || null,
        deleted:   stripTags(cells[13]) || null,
        sum:       stripTags(cells[14]),
        sameFederation: stripTags(cells[15]),
      });
    }
  }

  // --- Ranked athletes (the OTHER table — `table-striped rankingbody fixedheader`) ---
  // FIRST capture athlete bio IDs and the detailed result modals BEFORE stripping the modals,
  // so we don't lose the per-comp detail breakdowns.
  // Map: athlete bio id → array of { rank, points, competition, city, date }
  const detailByAthlete = {};
  const modalRe = /<div class="modal fade" id="info-(\d+)"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/g;
  let modalMatch;
  while ((modalMatch = modalRe.exec(html)) !== null) {
    const athleteId = modalMatch[1];
    const modalTableRows = rowsOf(modalMatch[2]);
    const details = [];
    for (const r of modalTableRows) {
      const tds = tdsOf(r).map(stripTags);
      if (tds.length < 5) continue;
      if (/^Rank$/i.test(tds[0])) continue;  // skip header
      details.push({
        placement: parseInt(tds[0]) || null,
        points:    parseFloat(tds[1]) || null,
        compName:  tds[2],
        city:      tds[3],
        date:      parseDmY(tds[4]),
      });
    }
    detailByAthlete[athleteId] = details;
  }

  // NOW strip modal divs so the outer rankingbody table can be matched cleanly
  const cleanedHtml = stripModals(html);
  const bodyTableM = cleanedHtml.match(/<table class="table table-striped table-sm rankingbody[^"]*"[\s\S]*?<\/table>/);
  if (bodyTableM) {
    const tableHtml = bodyTableM[0];
    // Column order: Rank, Points, T-P, Name, Nation, Club, YOB, then one per competition
    // Athletes rows are children of <tr> directly (no <tbody> wrapper sometimes).
    // Each athlete row is HUGE (with Details modal inside the Name cell).

    // Extract competition column anchors from the <thead>
    const theadM = tableHtml.match(/<thead[\s\S]*?<\/thead>/);
    const compIdsInOrder = [];
    if (theadM) {
      for (const m of theadM[0].matchAll(/<a href="#comp-(\d+)"/g)) {
        compIdsInOrder.push(+m[1]);
      }
    }

    // Each athlete <tr> starts with `<td class="ranking">RANK</td>`. Split on these markers carefully.
    // Simpler: pull each <tr> directly, then for each tr check if first cell is a number = rank.
    const rows = rowsOf(tableHtml);
    for (const r of rows) {
      // Skip header rows
      if (/<thead|<th\s/.test(r) && !/<td/.test(r)) continue;
      // The first td should be a numeric rank
      const firstTd = r.match(/<td class="ranking">(\d+)<\/td>/);
      if (!firstTd) continue;
      const rank = +firstTd[1];

      // Pull total points and T-P (transferred)
      // NOTE: must accept decimals ("329.5") — the previous \d+-only regex silently
      // skipped any cell whose value wasn't a whole number, which shifted points/
      // transferredPoints/yob out of alignment for every athlete with a half-point
      // total (very common under "Best result" scoring). Confirmed against a live
      // page: Eriksson Linnea's real row was rank=3, points=329.5, transferredPoints=0,
      // but the old regex produced points=0, transferredPoints=2008 (her YOB).
      const tdMatches = [...r.matchAll(/<td class="ranking">([\d.]+)<\/td>/g)];
      const points = tdMatches[1] ? +tdMatches[1][1] : null;
      const transferredPoints = tdMatches[2] ? +tdMatches[2][1] : null;

      // Athlete name (inside dropdown <a> tag with no extra classes)
      const nameM = r.match(/aria-haspopup="true"[^>]*>\s*([^<]+?)\s*<\/a>/);
      const name = nameM ? stripTags(nameM[1]) : "";

      // Athlete biography ID
      const bioM = r.match(/\/biography\/athlete\/(\d+)/);
      const athleteId = bioM ? bioM[1] : null;

      // Nation flag (could be multiple — take first 3-letter code)
      const flagM = [...r.matchAll(/\/img\/flags\/([a-z]{3})\.(?:svg|jpg|png)/g)];
      const nation = flagM[0] ? flagM[0][1].toUpperCase() : null;

      // Club (.rankingclub td content)
      const clubM = r.match(/<td class="ranking rankingclub">([\s\S]*?)<\/td>/);
      const club = clubM ? stripTags(clubM[1]) : "";

      // YOB
      const yobM = r.match(/<td class="ranking">(\d{4})<\/td>/);
      const yob = yobM ? +yobM[1] : null;

      // Per-comp result columns: look for .rankingfield cells (counted vs empty)
      const compCells = [...r.matchAll(/<td class="rankingfield(?:[^"]*)"[^>]*>([\s\S]*?)<\/td>/g)];
      const results = [];
      for (let i = 0; i < compCells.length; i++) {
        const cellHtml = compCells[i][1];
        if (/rankingfield-empty/.test(compCells[i][0])) continue;
        // Counted cell has a <span title="DATE City - Rank: N (Grp.: X) (Pointkey: Y)"> POINTS </span>
        const titleM = cellHtml.match(/title="([^"]+)"/);
        const ptsM   = cellHtml.match(/>\s*([\d.]+)\s*</);
        if (!ptsM) continue;
        const compId = compIdsInOrder[i] || null;
        results.push({
          ophardtCompId: compId,
          points: parseFloat(ptsM[1]),
          info: titleM ? decodeHtml(titleM[1]) : "",
        });
      }

      // Attach the detail-modal breakdown (more reliable than scraping the rotated columns)
      const details = athleteId ? detailByAthlete[athleteId] || [] : [];
      out.athletes.push({
        rank, points, transferredPoints, name, athleteId, nation, club, yob,
        results,        // from inline rotated columns
        details,        // from per-athlete modal (placement + points + name + city + date)
      });
    }
  }

  return out;
}

// ---------- main ----------
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));

  // Build out: catalog + selected rankings
  const out = {
    scrapedAt: new Date().toISOString(),
    source: "fencing.ophardt.online",
    fed: FED,
    season: SEASON,
    catalog: null,
    rankings: [],
  };

  if (ONLY_ID) {
    // Single ranking fetch
    const url = `https://fencing.ophardt.online/en/search/rankings/show/${ONLY_ID}`;
    const html = await fetchHTML(url);
    out.rankings.push(parseShowPage(html, ONLY_ID));
  } else {
    // Index fetch
    const indexUrl = `https://fencing.ophardt.online/en/search/rankings/${FED}?season=${SEASON}`;
    const indexHtml = await fetchHTML(indexUrl);
    out.catalog = parseIndexPage(indexHtml);
    log(`✓ Catalog: ${out.catalog.fedName} ${out.catalog.season}, ${Object.entries(out.catalog.categories).map(([k,v]) => k+'='+v.length).join(' · ')}`);

    if (TYPE === "index") {
      // Done — just save the catalog
    } else {
      // Filter rankings to fetch
      let toFetch = [];
      const cat = out.catalog.categories;
      if (TYPE === "vm-em" || TYPE === "all") toFetch = toFetch.concat(cat["Uttagning VM/EM"] || []);
      if (TYPE === "national" || TYPE === "all") toFetch = toFetch.concat(cat["Nationell Ranking"] || []);
      if (TYPE === "masters" || TYPE === "all") toFetch = toFetch.concat(cat["Masters"] || []);

      log(`→ Fetching ${toFetch.length} ranking detail pages`);
      let i = 0;
      for (const entry of toFetch) {
        i++;
        const url = `https://fencing.ophardt.online/en/search/rankings/show/${entry.id}`;
        try {
          const html = await fetchHTML(url);
          const parsed = parseShowPage(html, entry.id);
          parsed.catalogEntry = entry;
          out.rankings.push(parsed);
          log(`  [${i}/${toFetch.length}] ${entry.type} · ${entry.ageclass} · ${entry.weapon} · ${entry.gender}: ${parsed.athletes.length} athletes, ${parsed.competitions.length} comps`);
        } catch (e) {
          log(`  ✗ ${entry.id}: ${e.message}`);
        }
        if (i < toFetch.length) await sleep(THROTTLE);
      }
    }
  }

  const outPath = join(here, "swe_rankings.json");
  await writeFile(outPath, JSON.stringify(out, null, 2));
  log(`\n✓ Wrote ${out.rankings.length} ranking(s) to ${outPath}`);
  if (out.catalog) log(`  + catalog index for ${out.catalog.fedName} ${out.catalog.season}`);
}

main().catch(e => { console.error("✗", e.stack || e.message); process.exit(1); });
