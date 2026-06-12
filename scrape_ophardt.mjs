#!/usr/bin/env node
/*
 * scrape_ophardt.mjs — Pull Swedish (and other) fencing competitions from
 * fencing.ophardt.online and write competitions.json next to this script.
 *
 * Usage:
 *   node scrape_ophardt.mjs                       # Sweden, today → +12 months
 *   node scrape_ophardt.mjs --with-deadlines      # also fetch each event detail
 *                                                 # page for registration deadline
 *   node scrape_ophardt.mjs --nation=NOR
 *   node scrape_ophardt.mjs --from=2026-01-01 --to=2026-12-31
 *   node scrape_ophardt.mjs --level=nordic        # label-only
 *   node scrape_ophardt.mjs --quiet               # less log output
 *
 * Output: competitions.json next to this script.
 * Cache:  .scrape_cache/ alongside (HTML of detail pages, dedup-friendly).
 *
 * Requires: Node 18+ (global fetch). Zero npm dependencies.
 */

import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const today = new Date();
const ymd = d => d.toISOString().slice(0, 10);
const NATION = args.nation || "SWE";
const FROM = args.from || ymd(today);
const inOneYear = new Date(today); inOneYear.setFullYear(inOneYear.getFullYear() + 1);
const TO = args.to || ymd(inOneYear);
const LEVEL = args.level || "swedish";   // swedish | nordic | efc | fie
const QUIET = !!args.quiet;
const WITH_DEADLINES = !!args["with-deadlines"];
const DETAIL_THROTTLE_MS = parseInt(args.throttle) || 350;
const CACHE_TTL_HOURS = parseInt(args["cache-hours"]) || 24;

const log = (...a) => { if (!QUIET) console.log(...a); };

const URL_TEMPLATE = (from, to, nation) =>
  `https://fencing.ophardt.online/en/calendar?` +
  `date-from=${from}&date-to=${to}&nation=${nation}` +
  `&region=&city=&title=&group=&discipline=&gender=&ageclass=`;

// ---------- fetch ----------
async function fetchHTML(url) {
  log("→ GET", url);
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; FencerPath scraper; +https://fencerpath.se) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en,sv;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

// ---------- parse ----------
function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) { return decodeHtml(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

const MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
function parseDate(s) {
  // "Sep 13, 2025"
  const m = s.match(/([A-Z][a-z][a-z])\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS[m[1]]||0).padStart(2,"0")}-${String(+m[2]).padStart(2,"0")}`;
}
function parseDateRange(title) {
  // title="Sep 13, 2025 - Sep 14, 2025"
  if (!title) return [null, null];
  const parts = title.split(/\s*-\s*/);
  if (parts.length === 2) return [parseDate(parts[0]), parseDate(parts[1])];
  const d = parseDate(title); return [d, d];
}

const AGE_TOKENS = {
  "U11": "u11", "U13": "u13", "U15": "u15", "U17": "u17", "U20": "u20",
  "U23": "u23",
  "Seniorer": "senior", "Seniors": "senior", "Senior": "senior",
  "Veteraner": "veteran", "Veterans": "veteran", "Veteran": "veteran",
  "Cadet": "u17", "Junior": "u20",
};
function parseAges(text) {
  const toks = stripTags(text).split(/\s+/);
  const ages = new Set();
  toks.forEach(t => { const code = AGE_TOKENS[t]; if (code) ages.add(code); });
  return [...ages];
}

const REGION_NAMES = {
  ST: "Stockholm", SY: "Syd", VS: "Väst", NL: "Norrland",
  MS: "Mellansverige", OS: "Östra", GB: "Götaland",
};

// Split each <tbody><tr>...</tr> into row blocks (skipping bg-info dividers)
function splitRows(html) {
  // Crudely cut a window starting from the first <tbody> to the </table> after it.
  // The Ophardt page may have multiple <table>s; take the calendar table specifically.
  const tableMatch = html.match(/<table[^>]*class="[^"]*table-striped[^"]*"[^>]*>[\s\S]*?<\/table>/);
  if (!tableMatch) return [];
  const tbl = tableMatch[0];
  const rows = [];
  const re = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(tbl)) !== null) {
    if (/bg-info/.test(m[1])) continue;     // skip section headers
    rows.push(m[2]);
  }
  return rows;
}
function splitCells(rowHtml) {
  const cells = [];
  const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(rowHtml)) !== null) cells.push({ attrs: m[1], html: m[2] });
  return cells;
}
function attr(s, name) {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : "";
}

function parseCalendarPage(html, level) {
  const out = [];
  for (const row of splitRows(html)) {
    const cells = splitCells(row);
    // Expected layout (14 cells):
    // 0: blank padding
    // 1: status indicator
    // 2: "more infos" widget link (carries event id)
    // 3: invitation link (also carries event id)
    // 4: "Open for" — registration window
    // 5: Date — title="From - To"
    // 6: Nation — text "SWE ST"
    // 7: City — title="City"
    // 8: Title — anchor inside
    // 9: Age classes
    // 10: Epee weapon offered (icons)
    // 11: Foil weapon offered (icons)
    // 12: Sabre weapon offered (icons)
    // 13: ICS link
    if (cells.length < 13) continue;

    // event id from cell 2 widget link
    const widgetMatch = cells[2].html.match(/\/widget\/event\/(\d+)/);
    const eventId = widgetMatch ? widgetMatch[1] : null;
    if (!eventId) continue;

    // Date range from cell 5 title attr
    const [startDate, endDate] = parseDateRange(attr(cells[5].attrs, "title"));
    if (!startDate) continue;

    // "Open for" — text in cell 4 (registration close), if present
    const openFor = stripTags(cells[4].html);
    let regClose = null;
    // sometimes formatted as "Sep 5, 2025" or a range; take last date if it parses
    const dt = openFor && (parseDate(openFor.split(/\s*-\s*/).pop()) || parseDate(openFor));
    if (dt) regClose = dt;

    const nationCell = stripTags(cells[6].html);  // e.g. "SWE ST"
    const nationName = attr(cells[6].attrs, "title") || "";
    const [nationCode, regionCode] = nationCell.split(/\s+/);
    const city = attr(cells[7].attrs, "title") || stripTags(cells[7].html);

    // Title — extract text inside <a> if present
    const titleAnchor = cells[8].html.match(/<a[^>]*>([\s\S]*?)<\/a>/);
    const name = stripTags(titleAnchor ? titleAnchor[1] : cells[8].html);

    const ages = parseAges(cells[9].html);
    if (ages.length === 0) continue;

    const weapons = [];
    if (/<i\b/.test(cells[10].html)) weapons.push("epee");
    if (/<i\b/.test(cells[11].html)) weapons.push("foil");
    if (/<i\b/.test(cells[12].html)) weapons.push("sabre");
    if (weapons.length === 0) continue;

    // Fan out: one record per (weapon × age)
    for (const weapon of weapons) {
      for (const age of ages) {
        out.push({
          source: "ophardt",
          sourceId: `ophardt:${eventId}:${weapon}:${age}`,
          eventId,
          name,
          startDate,
          endDate,
          city,
          country: nationName || nationCode,
          weapon,
          ageCategory: age,
          level,
          regOpen: null,
          regClose,
          cancelDeadline: null,
          pointsPool: null,
          link: `https://fencing.ophardt.online/en/widget/event/${eventId}`,
          notes: regionCode ? `Region: ${regionCode}${REGION_NAMES[regionCode] ? " ("+REGION_NAMES[regionCode]+")" : ""}` : "",
        });
      }
    }
  }
  return out;
}

// ---------- detail page (registration / cancellation deadlines) ----------
async function ensureCacheDir(here) {
  const dir = join(here, ".scrape_cache");
  try { await mkdir(dir, { recursive: true }); } catch {}
  return dir;
}
async function readCachedHTML(cacheDir, eventId) {
  const path = join(cacheDir, `event-${eventId}.html`);
  try {
    const st = await stat(path);
    const ageHours = (Date.now() - st.mtimeMs) / 3_600_000;
    if (ageHours < CACHE_TTL_HOURS) return await readFile(path, "utf8");
  } catch {}
  return null;
}
async function writeCachedHTML(cacheDir, eventId, html) {
  await writeFile(join(cacheDir, `event-${eventId}.html`), html);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Heuristic deadline extraction from a widget event detail page.
 * Returns { regOpen, regClose, cancelDeadline } where each is YYYY-MM-DD or null.
 * Patterns try EN+SV labels and several layouts (table rows, key:value pairs).
 */
function extractDeadlines(html) {
  const result = { regOpen: null, regClose: null, cancelDeadline: null };
  // Normalize whitespace for easier matching (keep it for context)
  const flat = html.replace(/\s+/g, " ");

  // Common label → field mapping
  const labelGroups = [
    { fields: ["regOpen"], labels: [
      /registration\s*(?:opens?|begins?|starts?)/i,
      /anm[äa]lan\s*(?:öppnar|börjar)/i,
      /open\s*for\s*registration/i,
    ] },
    { fields: ["regClose"], labels: [
      /registration\s*(?:closes?|ends?|deadline|due)/i,
      /(?:end\s*of|last\s*day\s*of|until)\s*registration/i,
      /sista\s*(?:anm[äa]lningsdag|anm[äa]lan)/i,
      /anm[äa]lan\s*(?:st[äa]nger|slut|deadline)/i,
      /\bregistration\s*(?:end|close)\s*date/i,
    ] },
    { fields: ["cancelDeadline"], labels: [
      /cancel(?:lation|lation\s*deadline)?/i,
      /(?:dead)?line\s*for\s*cancellation/i,
      /avanm[äa]lning(?:sdatum|s\s*deadline)?/i,
      /sista\s*avanm[äa]lan/i,
    ] },
  ];

  // Strategy A: <th>Label</th><td>Date</td> table rows
  const trMatches = [...flat.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  for (const tr of trMatches) {
    const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => m[1]);
    if (cells.length < 2) continue;
    const labelText = stripTags(cells[0]);
    const valueText = stripTags(cells.slice(1).join(" | "));
    if (!labelText || !valueText) continue;
    for (const grp of labelGroups) {
      if (grp.labels.some(rx => rx.test(labelText))) {
        const d = pickAnyDate(valueText);
        if (d && !result[grp.fields[0]]) result[grp.fields[0]] = d;
      }
    }
  }

  // Strategy B: "Label: Date" inline fragments (text-only fallback)
  const text = stripTags(flat);
  for (const grp of labelGroups) {
    if (result[grp.fields[0]]) continue;
    for (const rx of grp.labels) {
      // Look for label followed (within ~80 chars) by something date-shaped
      const re = new RegExp(rx.source + "[^<\\n]{0,80}?(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|[A-Z][a-z][a-z]\\s+\\d{1,2},?\\s+\\d{4})", "i");
      const m = text.match(re);
      if (m) {
        const d = pickAnyDate(m[1]);
        if (d) { result[grp.fields[0]] = d; break; }
      }
    }
  }

  return result;
}

const MONTHS_FULL = {
  January:1, February:2, March:3, April:4, May:5, June:6, July:7,
  August:8, September:9, October:10, November:11, December:12,
  Januari:1, Februari:2, Mars:3, Maj:5, Juni:6, Juli:7, Augusti:8,
  Oktober:10, // (sv)
};
// Date parser that handles "2025-09-13", "13.9.2025", "13/09/2025", "Sep 13, 2025", "October 12, 2025"
function pickAnyDate(s) {
  if (!s) return null;
  s = s.trim();
  // ISO
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,"0")}-${String(+m[3]).padStart(2,"0")}`;
  // Full English/Swedish month
  m = s.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && (MONTHS_FULL[m[1]] || MONTHS[m[1].slice(0,3)])) {
    const mo = MONTHS_FULL[m[1]] || MONTHS[m[1].slice(0,3)];
    return `${m[3]}-${String(mo).padStart(2,"0")}-${String(+m[2]).padStart(2,"0")}`;
  }
  // dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy (assume European order)
  m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    let yr = +m[3]; if (yr < 100) yr += yr > 70 ? 1900 : 2000;
    return `${yr}-${String(+m[2]).padStart(2,"0")}-${String(+m[1]).padStart(2,"0")}`;
  }
  return null;
}

async function enrichWithDeadlines(records, here) {
  const cacheDir = await ensureCacheDir(here);
  const distinctEventIds = [...new Set(records.map(r => r.eventId))];
  log(`\n→ Fetching ${distinctEventIds.length} detail page(s) for deadlines (cache: ${CACHE_TTL_HOURS}h)`);
  const deadlines = new Map();
  let i = 0, fromCache = 0, hits = { regOpen: 0, regClose: 0, cancelDeadline: 0 };
  for (const eventId of distinctEventIds) {
    i++;
    let html = await readCachedHTML(cacheDir, eventId);
    if (html) { fromCache++; }
    else {
      const url = `https://fencing.ophardt.online/en/widget/event/${eventId}`;
      try {
        html = await fetchHTML(url);
        await writeCachedHTML(cacheDir, eventId, html);
        await sleep(DETAIL_THROTTLE_MS);
      } catch (e) {
        log(`  [${i}/${distinctEventIds.length}] event ${eventId}: ${e.message}`);
        continue;
      }
    }
    const d = extractDeadlines(html);
    deadlines.set(eventId, d);
    if (d.regOpen) hits.regOpen++;
    if (d.regClose) hits.regClose++;
    if (d.cancelDeadline) hits.cancelDeadline++;
    if (!QUIET && i % 10 === 0) log(`  …${i}/${distinctEventIds.length}`);
  }
  log(`  cache hits: ${fromCache}/${distinctEventIds.length}`);
  log(`  found regOpen=${hits.regOpen}, regClose=${hits.regClose}, cancelDeadline=${hits.cancelDeadline}`);
  // Apply to records
  for (const r of records) {
    const d = deadlines.get(r.eventId); if (!d) continue;
    if (d.regOpen)        r.regOpen        = d.regOpen;
    if (d.regClose)       r.regClose       = d.regClose;
    if (d.cancelDeadline) r.cancelDeadline = d.cancelDeadline;
  }
}

// ---------- main ----------
async function main() {
  const url = URL_TEMPLATE(FROM, TO, NATION);
  log(`Scraping Ophardt: nation=${NATION} from=${FROM} to=${TO} level=${LEVEL}` + (WITH_DEADLINES ? " +deadlines" : ""));
  const html = await fetchHTML(url);
  const items = parseCalendarPage(html, LEVEL);

  const here = dirname(fileURLToPath(import.meta.url));

  // Dedupe by sourceId (latest wins, but they should already be unique)
  const seen = new Map();
  for (const it of items) seen.set(it.sourceId, it);
  const list = [...seen.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (WITH_DEADLINES) await enrichWithDeadlines(list, here);

  const outPath = join(here, "competitions.json");
  await writeFile(outPath, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    source: "fencing.ophardt.online",
    sourceUrl: url,
    nation: NATION,
    level: LEVEL,
    count: list.length,
    competitions: list,
  }, null, 2));

  log(`✓ Wrote ${list.length} records to ${outPath}`);
  log(`  (${new Set(list.map(x => x.eventId)).size} distinct events × weapon × age)`);

  // brief breakdown
  const byWeapon = list.reduce((m, x) => (m[x.weapon] = (m[x.weapon]||0)+1, m), {});
  const byAge    = list.reduce((m, x) => (m[x.ageCategory] = (m[x.ageCategory]||0)+1, m), {});
  log("  by weapon:", byWeapon);
  log("  by age:   ", byAge);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
