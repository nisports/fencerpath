#!/usr/bin/env node
/**
 * scrape_vmem_rankings.mjs
 *
 * Scrapes "Uttagning VM/EM" from Svenska Fäktförbundet on Ophardt Online.
 * Outputs vmem_rankings_<weapon>_<age>_<gender>.json next to this script.
 *
 * Usage:
 *   node scrape_vmem_rankings.mjs --weapon epee --age senior --gender M [--season 2025]
 *   node scrape_vmem_rankings.mjs --all   (all VM/EM rankings)
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "https://fencing.ophardt.online";
const FEDERATION_ID = 3;

const WEAPON_COLS = ["epee", "foil", "sabre"];
const AGE_MAP = {
  senior: "senior", u23: "u23", u20: "u20", u17: "u17",
  u15: "u15", u13: "u13", u11: "u11", veteran: "veteran",
};

// ── CLI ───────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const get      = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
const scrapeAll = args.includes("--all");
const weaponArg = (get("--weapon") || "").toLowerCase();
const ageArg    = (get("--age")    || "senior").toLowerCase();
const genderArg = (get("--gender") || "M").toUpperCase();
const seasonArg = get("--season")  || "2025";

if (!scrapeAll && !weaponArg) {
  console.error("Usage:");
  console.error("  node scrape_vmem_rankings.mjs --weapon epee --age senior --gender M");
  console.error("  node scrape_vmem_rankings.mjs --all");
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "FencerPath/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** "KELLY Christopher" → "Christopher Kelly" */
function normaliseName(raw) {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return raw.trim();
  if (parts[0] === parts[0].toUpperCase() && /[A-ZÅÄÖ]/.test(parts[0])) {
    const last  = parts[0][0] + parts[0].slice(1).toLowerCase();
    const first = parts.slice(1).join(" ");
    return `${first} ${last}`;
  }
  return raw.trim();
}

// ── parse index page → map of "age-gender-weapon" → showId ───────────────────
async function fetchVmEmMap(season) {
  const url  = `${BASE}/en/search/rankings/${FEDERATION_ID}?season=${season}`;
  console.error(`Fetching index: ${url}`);
  const html = await fetchText(url);

  // Locate the VM/EM card — take a generous window (8 KB) from that point
  const start = html.indexOf("Uttagning VM/EM");
  if (start === -1) throw new Error("Could not find 'Uttagning VM/EM' section");
  const section = html.slice(start, start + 8000);

  // Each age row has a <th style="font-size: 150%;"> — this is unique to age rows
  const rowRe = /<th style="font-size: 150%;">\s*(.*?)\s*<\/th>([\s\S]*?)(?=<tr>|<\/tbody>)/g;
  const map   = {};
  let row;

  while ((row = rowRe.exec(section)) !== null) {
    const age    = AGE_MAP[row[1].trim().toLowerCase()] || row[1].trim().toLowerCase();
    const cells  = row[2];
    // Each <td> is one weapon column: first 3 = Men's, next 3 = Women's
    const cellRe = /<td>([\s\S]*?)<\/td>/g;
    let cell, col = 0;
    while ((cell = cellRe.exec(cells)) !== null) {
      const gender = col < 3 ? "M" : "F";
      const weapon = WEAPON_COLS[col % 3];
      const link   = cell[1].match(/\/en\/search\/rankings\/show\/(\d+)/);
      if (link) map[`${age}-${gender}-${weapon}`] = link[1];
      col++;
    }
  }

  return map;
}

// ── showId → HTML ranking page id (follow redirect) ──────────────────────────
async function resolveHtmlId(showId) {
  const html  = await fetchText(`${BASE}/en/search/rankings/show/${showId}`);
  const match = html.match(/url='\/en\/show-ranking\/html\/(\d+)'/);
  if (!match) throw new Error(`Could not resolve HTML id for show/${showId}`);
  return match[1];
}

// ── scrape one ranking page ───────────────────────────────────────────────────
async function scrapeRanking({ weapon, age, gender, showId }) {
  console.error(`  Resolving show/${showId}…`);
  const htmlId = await resolveHtmlId(showId);
  const url    = `${BASE}/en/show-ranking/html/${htmlId}`;
  console.error(`  Fetching: ${url}`);
  const html   = await fetchText(url);

  const rowRe =
    /<td class="ranking">(\d+)<\/td>\s*<td class="ranking">([\d.]+)<\/td>\s*<td class="ranking">[\d.]*<\/td>\s*<td class="ranking">([\s\S]*?)<\/td>/g;

  const rankings = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const nameMatch = m[3].match(/dropdown-toggle[^>]*>\s*([A-ZÅÄÖÉÈÜÑA-Za-zåäöéèü'\-\s]+?)\s*\n/);
    if (!nameMatch) continue;
    rankings.push({
      rank:    parseInt(m[1]),
      points:  parseFloat(m[2]),
      name:    normaliseName(nameMatch[1].trim()),
      rawName: nameMatch[1].trim(),
    });
  }

  return {
    scrapedAt: new Date().toISOString(),
    filters: { weapon, age, gender, nation: "SWE", type: "vmem" },
    rankings,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function run() {
  const vmemMap = await fetchVmEmMap(seasonArg);
  const keys    = Object.keys(vmemMap);
  console.error(`Found ${keys.length} VM/EM rankings: ${keys.join(", ")}\n`);

  const targets = scrapeAll
    ? keys.map(key => {
        const [age, gender, weapon] = key.split("-");
        return { age, gender, weapon, showId: vmemMap[key] };
      })
    : (() => {
        const key    = `${ageArg}-${genderArg}-${weaponArg}`;
        const showId = vmemMap[key];
        if (!showId) {
          console.error(`No VM/EM ranking found for: ${key}`);
          console.error("Available:", keys.join(", "));
          process.exit(1);
        }
        return [{ age: ageArg, gender: genderArg, weapon: weaponArg, showId }];
      })();

  let ok = 0, fail = 0;
  for (const target of targets) {
    const { age, gender, weapon } = target;
    console.error(`Scraping: ${weapon} ${age} ${gender}`);
    try {
      const result   = await scrapeRanking(target);
      const filename = join(__dirname, `vmem_rankings_${weapon}_${age}_${gender}.json`);
      writeFileSync(filename, JSON.stringify(result, null, 2), "utf8");
      console.log(`✓ vmem_rankings_${weapon}_${age}_${gender}.json  (${result.rankings.length} athletes)`);
      if (result.rankings.length > 0) {
        const top3 = result.rankings.slice(0, 3)
          .map(r => `#${r.rank} ${r.name} ${r.points}pts`).join("  ·  ");
        console.log(`  ${top3}`);
      }
      ok++;
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${ok} file(s) saved to: ${__dirname}`);
  console.log(`Import each file via FencerPath → Settings → 🏆 Pick vmem_rankings.json…`);
  if (fail > 0) console.error(`${fail} ranking(s) failed — check errors above`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
