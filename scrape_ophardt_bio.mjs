#!/usr/bin/env node
/*
 * scrape_ophardt_bio.mjs — Pull individual fencer biographies from
 * fencing.ophardt.online/en/biography/athlete/{slug} and write bio.json.
 *
 * Slug format on Ophardt: lastname-firstname  (e.g. "kong-kenneth")
 *
 * Usage:
 *   node scrape_ophardt_bio.mjs --slug=kong-kenneth
 *   node scrape_ophardt_bio.mjs --slugs=kong-kenneth,lindqvist-anna,berg-sofia
 *   node scrape_ophardt_bio.mjs --slug=kong-kenneth --slug=lindqvist-anna   (repeat)
 *
 * Output: bio.json — array of bio records, each with rankings keyed by
 *         scope ("national" | "continental" | "international") × weapon × age.
 *
 * Requires: Node 18+. No npm install.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------- args ----------
const argList = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) argList.push([m[1], m[2]]);
  else argList.push([a.replace(/^--/, ""), true]);
}
const arg = (k, def) => {
  const matches = argList.filter(([n]) => n === k).map(([, v]) => v);
  return matches.length ? matches : (def !== undefined ? [def] : []);
};
const QUIET = !!arg("quiet", false)[0];
const log = (...a) => { if (!QUIET) console.log(...a); };

const slugs = [
  ...arg("slug"),
  ...arg("slugs").flatMap(s => typeof s === "string" ? s.split(",") : []),
].map(s => String(s).trim().toLowerCase()).filter(Boolean);

if (slugs.length === 0) {
  console.error("✗ Need at least one --slug=lastname-firstname");
  console.error("  Tip: visit https://fencing.ophardt.online/en/search/biographies, search a name,");
  console.error("       click a result, and copy the slug from the URL after /athlete/");
  process.exit(2);
}

const THROTTLE_MS = parseInt(arg("throttle", "400")[0]) || 400;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fetch ----------
async function fetchHTML(url) {
  log("→ GET", url);
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; FencerPath bio scraper; +https://fencerpath.se) AppleWebKit/537.36",
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
function attr(html, name, idx = 0) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "gi");
  let i = -1, m;
  while ((m = re.exec(html))) { i++; if (i === idx) return m[1]; }
  return "";
}

const WEAPON_FROM_BADGE = { Foil: "foil", Epee: "epee", Sabre: "sabre",
  Florett: "foil", Värja: "epee", Sabel: "sabre", Epée: "epee", "Épée": "epee" };

const AGE_FROM_TEXT = {
  U10: "u10", U11: "u11", U13: "u13", U15: "u15", U17: "u17", U20: "u20", U23: "u23",
  Senior: "senior", Seniors: "senior", Cadet: "u17", Junior: "u20",
  Veteran: "veteran", Veterans: "veteran",
};

function parseBioPage(html, slug) {
  // Title page section — bounded by page-header start and bios_main start
  const headerBlock = html.match(/<div class="page-header[^"]*">([\s\S]*?)<div class="bios_main"/);
  const headerHtml = headerBlock ? headerBlock[1] : html;

  // Name
  const name = stripTags(headerHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || "") || slug.replace(/-/g, " ");

  // Club — first <p> after h1
  const afterH1 = headerHtml.split(/<\/h1>/)[1] || "";
  const clubMatch = afterH1.match(/<p[^>]*>\s*([^<]+?)\s*<\/p>/);
  const club = stripTags(clubMatch ? clubMatch[1] : "");

  // Weapons — badge spans
  const weapons = new Set();
  for (const b of headerHtml.matchAll(/<span[^>]*class="[^"]*(bg-info|bg-danger|bg-success|bg-warning|bg-primary)[^"]*"[^>]*>\s*([A-Za-z]+)\s*<\/span>/g)) {
    const w = WEAPON_FROM_BADGE[stripTags(b[2])];
    if (w) weapons.add(w);
  }

  // Nation — h3 in col-md-1 (typically a 3-letter code)
  let nation = stripTags(headerHtml.match(/<h3[^>]*>\s*([A-Z]{3})\s*<\/h3>/)?.[1] || "");

  // Age
  const ageMatch = headerHtml.match(/title="Age"[\s\S]*?<br\s*\/?>(\d{1,3})/);
  const age = ageMatch ? parseInt(ageMatch[1]) : null;

  // Gender — fa-mars / fa-venus
  let gender = "";
  if (/fa-mars\b/.test(headerHtml)) gender = "M";
  else if (/fa-venus\b/.test(headerHtml)) gender = "F";

  // Rankings — find h3 "Rankings" then 3 h4 sections
  const rankings = { international: [], continental: [], national: [] };
  const rxRanksBlock = /<h3[^>]*>\s*Rankings\s*<\/h3>([\s\S]*?)(?:<h3|<\/div>\s*<\/div>\s*<\/div>\s*$)/;
  const ranksBlock = html.match(rxRanksBlock)?.[1] || "";
  const sectionRx = /<h4[^>]*>\s*(International|Continental|National)\s*<\/h4>([\s\S]*?)(?=<h4|$)/g;
  for (const sm of ranksBlock.matchAll(sectionRx)) {
    const scope = sm[1].toLowerCase();
    const tableHtml = sm[2];
    const tbody = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || tableHtml;
    for (const r of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
      if (cells.length < 5) continue;
      const rank   = parseInt(stripTags(cells[0]));
      const points = parseFloat(stripTags(cells[1]).replace(",", "."));
      const season = stripTags(cells[2]);
      const title  = stripTags(cells[3]);
      // Competition cell: anchor with "Weapon\n   Age\n   Individual"
      const compTokens = stripTags(cells[4]).split(/\s+/);
      // Detect weapon and age
      let weapon = null, age = null, kind = "Individual";
      for (const tok of compTokens) {
        const w = WEAPON_FROM_BADGE[tok]; if (w) weapon = w;
        const a = AGE_FROM_TEXT[tok]; if (a) age = a;
        if (/team/i.test(tok)) kind = "Team";
      }
      if (!rank || !weapon) continue;
      rankings[scope].push({ rank, points, season, title, weapon, age, kind });
    }
  }

  // Memberships — find h3 "Memberships"
  const memBlock = html.match(/<h3[^>]*>\s*Memberships\s*<\/h3>([\s\S]*?)(?:<h3|<\/table>\s*<\/div>\s*<\/div>)/);
  const memberships = [];
  if (memBlock) {
    const tbody = memBlock[1].match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || memBlock[1];
    for (const r of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => stripTags(c[1]));
      if (cells.length < 4) continue;
      memberships.push({
        club: cells[0], type: cells[1], start: cells[2], end: cells[3],
        active: !cells[3], note: cells[4] || "",
      });
    }
  }

  return {
    source: "ophardt",
    sourceUrl: `https://fencing.ophardt.online/en/biography/athlete/${slug}`,
    slug,
    name,
    nation,
    gender,
    age,
    club,
    weapons: [...weapons],
    rankings,
    memberships,
  };
}

// ---------- main ----------
async function main() {
  const all = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const url = `https://fencing.ophardt.online/en/biography/athlete/${slug}`;
    try {
      const html = await fetchHTML(url);
      const bio = parseBioPage(html, slug);
      all.push(bio);
      log(`  ✓ ${bio.name} — ${bio.weapons.join("/")} · ${bio.club}` +
        ` · rankings: nat=${bio.rankings.national.length} cont=${bio.rankings.continental.length} intl=${bio.rankings.international.length}`);
    } catch (e) {
      log(`  ✗ ${slug}: ${e.message}`);
      all.push({ source: "ophardt", slug, error: e.message });
    }
    if (i < slugs.length - 1) await sleep(THROTTLE_MS);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, "bio.json");
  await writeFile(outPath, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    source: "fencing.ophardt.online",
    count: all.length,
    bios: all,
  }, null, 2));
  log(`\n✓ Wrote ${all.length} bio(s) to ${outPath}`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
