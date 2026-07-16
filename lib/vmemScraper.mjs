/**
 * lib/vmemScraper.mjs
 *
 * Shared "Uttagning VM/EM" (VM/EM selection ranking) scraping logic for Svenska
 * Fäktförbundet on Ophardt Online.
 *
 * This used to live only inside scrape_vmem_rankings.mjs (a CLI script Tina ran
 * locally, then manually imported the resulting JSON into the app). It's now
 * extracted into its own module so the SAME scraping/parsing logic can be reused
 * by:
 *   - scrape_vmem_rankings.mjs   (CLI — manual/local runs, unchanged behavior)
 *   - api/cron/sync-rankings.mjs (Vercel Cron — automatic daily sync per combo)
 *
 * Keeping one source of truth here means a future fix to Ophardt's HTML structure
 * (their markup has already changed shape at least once — see the regexes below)
 * only needs to happen in one place instead of silently drifting between the CLI
 * script and the serverless function.
 */

export const BASE = "https://fencing.ophardt.online";
export const FEDERATION_ID = 3;

export const WEAPON_COLS = ["epee", "foil", "sabre"];
export const AGE_MAP = {
  senior: "senior", u23: "u23", u20: "u20", u17: "u17",
  u15: "u15", u13: "u13", u11: "u11", veteran: "veteran",
};

export async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "FencerPath/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** "KELLY Christopher" → "Christopher Kelly" */
export function normaliseName(raw) {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return raw.trim();
  if (parts[0] === parts[0].toUpperCase() && /[A-ZÅÄÖ]/.test(parts[0])) {
    const last  = parts[0][0] + parts[0].slice(1).toLowerCase();
    const first = parts.slice(1).join(" ");
    return `${first} ${last}`;
  }
  return raw.trim();
}

/** Parse the index page → map of "age-gender-weapon" → showId, for one season. */
export async function fetchVmEmMap(season) {
  const url  = `${BASE}/en/search/rankings/${FEDERATION_ID}?season=${season}`;
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

/**
 * showId → HTML ranking page id.
 *
 * As of 2026-07 Ophardt resolves /en/search/rankings/show/<id> via a real HTTP 302
 * (Location: /en/show-ranking/html/<htmlId>) rather than the client-side meta-refresh
 * interstitial it used to serve (which embedded a literal `url='/en/show-ranking/html/…'`
 * string in the page body — that's what the old regex-only version of this function
 * looked for). Since fetch() already follows the redirect, the resolved id can just be
 * read off `res.url`. Kept the old body-regex as a fallback in case Ophardt ever serves
 * the interstitial again for some paths — their markup has changed shape more than once.
 */
export async function resolveHtmlId(showId) {
  const url = `${BASE}/en/search/rankings/show/${showId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "FencerPath/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);

  const fromFinalUrl = res.url && res.url.match(/\/en\/show-ranking\/html\/(\d+)/);
  if (fromFinalUrl) return fromFinalUrl[1];

  const html = await res.text();
  const fromBody = html.match(/url='\/en\/show-ranking\/html\/(\d+)'/);
  if (!fromBody) throw new Error(`Could not resolve HTML id for show/${showId}`);
  return fromBody[1];
}

/** Scrape one ranking page into { scrapedAt, filters, rankings } */
export async function scrapeRanking({ weapon, age, gender, showId }) {
  const htmlId = await resolveHtmlId(showId);
  const url    = `${BASE}/en/show-ranking/html/${htmlId}`;
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

/**
 * Fencing season key for a date — Aug → next Jul. Returns "25/26" form.
 * Mirrors seasonOf() in index.html so the cron function and the app agree on
 * which season is "current" without sharing any client-side state.
 */
export function seasonOfDate(date = new Date()) {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 7 ? y : y - 1; // Aug = month 7 (0-indexed)
  return `${String(startYear).slice(-2)}/${String(startYear + 1).slice(-2)}`;
}

/** "25/26" → "2025" (Ophardt's index page wants the season's starting year as a plain number) */
export function seasonKeyToOphardtYear(seasonKey) {
  const m = String(seasonKey).match(/^(\d{2})\/(\d{2})$/);
  if (!m) return String(new Date().getFullYear());
  const startYY = parseInt(m[1], 10);
  // Assume 20xx — this app has no 19xx seasons to worry about.
  return String(2000 + startYY);
}

/**
 * High-level convenience: scrape one weapon/age/gender combo for the CURRENT
 * season and return the same shape scrape_vmem_rankings.mjs writes to disk.
 * Used by api/cron/sync-rankings.mjs (each cron invocation handles one combo).
 */
export async function scrapeOneCombo({ weapon, age, gender, season }) {
  const seasonKey    = season || seasonOfDate();
  const ophardtYear   = seasonKeyToOphardtYear(seasonKey);
  const vmemMap       = await fetchVmEmMap(ophardtYear);
  const key           = `${age}-${gender}-${weapon}`;
  const showId        = vmemMap[key];
  if (!showId) {
    throw new Error(`No VM/EM ranking found for ${key} (season ${seasonKey}/${ophardtYear}). Available: ${Object.keys(vmemMap).join(", ")}`);
  }
  const result = await scrapeRanking({ weapon, age, gender, showId });
  return { ...result, season: seasonKey };
}
