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
 *
 * NOTE (2026-07-16): the actual scraping/parsing logic now lives in
 * lib/vmemScraper.mjs, shared with api/cron/sync-rankings.mjs (the automated
 * daily Vercel Cron sync). This file is just the CLI wrapper — argument
 * parsing, console output, and writing results to disk. Keep it thin so the
 * two entry points never drift apart on how they parse Ophardt's HTML.
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fetchVmEmMap, scrapeRanking } from "./lib/vmemScraper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const get       = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
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

function indexUrl(season) {
  return `https://fencing.ophardt.online/en/search/rankings/3?season=${season}`;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.error(`Fetching index: ${indexUrl(seasonArg)}`);
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
    const { age, gender, weapon, showId } = target;
    console.error(`Scraping: ${weapon} ${age} ${gender}`);
    try {
      const result   = await scrapeRanking({ weapon, age, gender, showId });
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
