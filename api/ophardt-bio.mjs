/*
 * api/ophardt-bio.mjs — Vercel serverless function.
 *
 * GET /api/ophardt-bio?slug=lastname-firstname
 *
 * Fetches an individual fencer biography from
 * fencing.ophardt.online/en/biography/athlete/{slug} server-side (avoids
 * browser CORS) and returns the parsed bio as JSON.
 *
 * Parsing logic ported directly from scrape_ophardt_bio.mjs (same repo) —
 * keep the two in sync if Ophardt's HTML structure changes.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

// ---------- parse helpers (ported from scrape_ophardt_bio.mjs) ----------
function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) { return decodeHtml(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(); }

const WEAPON_FROM_BADGE = { Foil: "foil", Epee: "epee", Sabre: "sabre",
  Florett: "foil", Värja: "epee", Sabel: "sabre", Epée: "epee", "Épée": "epee" };

const AGE_FROM_TEXT = {
  U10: "u10", U11: "u11", U13: "u13", U15: "u15", U17: "u17", U20: "u20", U23: "u23",
  Senior: "senior", Seniors: "senior", Cadet: "u17", Junior: "u20",
  Veteran: "veteran", Veterans: "veteran",
};

function parseBioPage(html, slug) {
  const headerBlock = html.match(/<div class="page-header[^"]*">([\s\S]*?)<div class="bios_main"/);
  const headerHtml = headerBlock ? headerBlock[1] : html;

  const name = stripTags(headerHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || "") || slug.replace(/-/g, " ");

  const afterH1 = headerHtml.split(/<\/h1>/)[1] || "";
  const clubMatch = afterH1.match(/<p[^>]*>\s*([^<]+?)\s*<\/p>/);
  const club = stripTags(clubMatch ? clubMatch[1] : "");

  const weapons = new Set();
  for (const b of headerHtml.matchAll(/<span[^>]*class="[^"]*(bg-info|bg-danger|bg-success|bg-warning|bg-primary)[^"]*"[^>]*>\s*([A-Za-z]+)\s*<\/span>/g)) {
    const w = WEAPON_FROM_BADGE[stripTags(b[2])];
    if (w) weapons.add(w);
  }

  let nation = stripTags(headerHtml.match(/<h3[^>]*>\s*([A-Z]{3})\s*<\/h3>/)?.[1] || "");

  const ageMatch = headerHtml.match(/title="Age"[\s\S]*?<br\s*\/?>(\d{1,3})/);
  const age = ageMatch ? parseInt(ageMatch[1]) : null;

  let gender = "";
  if (/fa-mars\b/.test(headerHtml)) gender = "M";
  else if (/fa-venus\b/.test(headerHtml)) gender = "F";

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
      const compTokens = stripTags(cells[4]).split(/\s+/);
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
    scrapedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const rawSlug = String(req.query?.slug || "").trim().toLowerCase();
  if (!rawSlug) {
    res.status(400).json({ error: "Missing required 'slug' query param." });
    return;
  }
  if (!SLUG_RE.test(rawSlug)) {
    res.status(400).json({ error: "Invalid slug format. Expected 'lastname-firstname'." });
    return;
  }

  const url = `https://fencing.ophardt.online/en/biography/athlete/${rawSlug}`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; FencerPath bio lookup; +https://fencerpath.com) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en,sv;q=0.8",
      },
      redirect: "follow",
    });
    if (!r.ok) {
      res.status(r.status === 404 ? 404 : 502).json({
        error: r.status === 404
          ? "No Ophardt profile found for this slug."
          : `Ophardt returned HTTP ${r.status}.`,
      });
      return;
    }
    const html = await r.text();
    const bio = parseBioPage(html, rawSlug);
    if (!bio.name || bio.name === rawSlug.replace(/-/g, " ")) {
      // Parsed but couldn't find a real <h1> name — likely a soft-404 or unexpected page shape.
      res.status(404).json({ error: "Could not find a profile for this slug on Ophardt." });
      return;
    }
    res.status(200).json(bio);
  } catch (e) {
    res.status(502).json({ error: `Fetch failed: ${e.message}` });
  }
}
