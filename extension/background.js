/**
 * FencerPath Ranking Sync — background service worker.
 *
 * Once a day (and when Chrome starts) it fetches the Svensk Ranking tables from
 * Ophardt using THIS browser's normal session, then POSTs them to
 * /api/ingest-rankings on FencerPath.
 *
 * It never tries to solve or bypass Cloudflare's challenge. If Ophardt answers
 * with a challenge page, it stops, shows a "!" badge + notification, and waits
 * until you open any Ophardt page yourself; then it retries automatically.
 *
 * Parsing mirrors lib/vmemScraper.mjs (keep them in sync if Ophardt changes HTML).
 */

const BASE = "https://fencing.ophardt.online";
const FEDERATION_ID = 3;
const WEAPON_COLS = ["epee", "foil", "sabre"];
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // at most one successful sync per ~day
const REQUEST_GAP_MS = 1500;                  // be gentle: one request at a time

class ChallengeError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function seasonOfDate(d = new Date()) {
  const start = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
  return { key: `${String(start).slice(-2)}/${String(start + 1).slice(-2)}`, ophardtYear: String(start) };
}

async function get(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow" });
  if (res.status === 403 || res.status === 503) {
    if (res.headers.get("cf-mitigated") === "challenge") throw new ChallengeError(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const text = await res.text();
  if (/<title>Just a moment\.\.\.<\/title>/.test(text)) throw new ChallengeError(url);
  return { url: res.url, text };
}

function normaliseName(raw) {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return raw.trim();
  if (parts[0] === parts[0].toUpperCase() && /[A-ZÅÄÖ]/.test(parts[0])) {
    return `${parts.slice(1).join(" ")} ${parts[0][0]}${parts[0].slice(1).toLowerCase()}`;
  }
  return raw.trim();
}

function parseIndex(html) {
  let start = html.indexOf("Svensk ranking");
  if (start === -1) start = html.indexOf("Uttagning VM/EM");
  if (start === -1) throw new Error("Hittade inte avsnittet 'Svensk ranking' på Ophardt");
  const section = html.slice(start, start + 8000);
  const rowRe = /<th style="font-size: 150%;">\s*(.*?)\s*<\/th>([\s\S]*?)(?=<tr>|<\/tbody>)/g;
  const out = [];
  let row;
  while ((row = rowRe.exec(section)) !== null) {
    const age = row[1].trim().toLowerCase();
    const cellRe = /<td>([\s\S]*?)<\/td>/g;
    let cell, col = 0;
    while ((cell = cellRe.exec(row[2])) !== null) {
      const link = cell[1].match(/\/en\/search\/rankings\/show\/(\d+)/);
      if (link) out.push({ age, gender: col < 3 ? "M" : "F", weapon: WEAPON_COLS[col % 3], showId: link[1] });
      col++;
    }
  }
  return out;
}

function parseRanking(html) {
  const rowRe = /<td class="ranking">(\d+)<\/td>\s*<td class="ranking">([\d.]+)<\/td>\s*<td class="ranking">[\d.]*<\/td>\s*<td class="ranking">([\s\S]*?)<\/td>/g;
  const out = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const nm = m[3].match(/dropdown-toggle[^>]*>\s*([^<\n]+?)\s*(?:\n|<)/);
    if (!nm) continue;
    const raw = nm[1].trim();
    out.push({ rank: parseInt(m[1], 10), points: parseFloat(m[2]), name: normaliseName(raw), rawName: raw });
  }
  return out;
}

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
  const badge = status.state === "ok" ? "" : status.state === "challenge" ? "!" : "×";
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: status.state === "challenge" ? "#d97706" : "#dc2626" });
}

let running = false;
export async function syncNow({ force = false } = {}) {
  if (running) return;
  running = true;
  try {
    const { config = {}, lastSuccess } = await chrome.storage.local.get(["config", "lastSuccess"]);
    if (!config.endpoint || !config.secret) {
      await setStatus({ state: "error", message: "Ange FencerPath-adress och nyckel i inställningarna." });
      return;
    }
    if (!force && lastSuccess && Date.now() - new Date(lastSuccess).getTime() < MIN_INTERVAL_MS) return;

    const season = seasonOfDate();
    const index = await get(`${BASE}/en/search/rankings/${FEDERATION_ID}?season=${season.ophardtYear}`);
    const entries = parseIndex(index.text);
    if (!entries.length) throw new Error("Inga rankinglistor hittades på Ophardt");

    const combos = [];
    for (const e of entries) {
      await sleep(REQUEST_GAP_MS);
      const show = await get(`${BASE}/en/search/rankings/show/${e.showId}`);
      let htmlId = (show.url.match(/\/en\/show-ranking\/html\/(\d+)/) || [])[1]
                || (show.text.match(/url='\/en\/show-ranking\/html\/(\d+)'/) || [])[1];
      let pageHtml = show.text;
      if (htmlId && !/\/show-ranking\/html\//.test(show.url)) {
        await sleep(REQUEST_GAP_MS);
        pageHtml = (await get(`${BASE}/en/show-ranking/html/${htmlId}`)).text;
      }
      const rankings = parseRanking(pageHtml);
      if (rankings.length) combos.push({ weapon: e.weapon, age: e.age, gender: e.gender, scrapedAt: new Date().toISOString(), rankings });
    }

    const res = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/ingest-rankings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.secret}` },
      body: JSON.stringify({ season: season.key, combos }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`FencerPath svarade ${res.status}: ${out.error || ""}`);

    await chrome.storage.local.set({ lastSuccess: new Date().toISOString() });
    await setStatus({ state: "ok", message: `${out.saved} listor sparade (${season.key})${out.rejected?.length ? `, ${out.rejected.length} avvisade` : ""}` });
  } catch (err) {
    if (err instanceof ChallengeError) {
      await setStatus({ state: "challenge", message: "Ophardt kräver webbläsarkontroll. Öppna valfri Ophardt-sida en gång, så försöker tillägget igen." });
      chrome.notifications.create("ophardt-challenge", {
        type: "basic", iconUrl: "icon.png",
        title: "FencerPath Ranking Sync",
        message: "Öppna fencing.ophardt.online en gång så att rankingen kan uppdateras.",
      });
    } else {
      await setStatus({ state: "error", message: err.message });
    }
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("daily", { periodInMinutes: 60 }));
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create("daily", { periodInMinutes: 60 }); syncNow(); });
// Hourly tick; syncNow() itself skips if the last success was < 20 h ago.
chrome.alarms.onAlarm.addListener(a => { if (a.name === "daily") syncNow(); });

// After you open an Ophardt page yourself (which lets Chrome pass the check
// normally), retry right away if the last attempt was blocked.
chrome.tabs?.onUpdated?.addListener(async (_id, info, tab) => {
  if (info.status !== "complete" || !tab.url?.startsWith(BASE)) return;
  const { status } = await chrome.storage.local.get("status");
  if (status?.state === "challenge") syncNow({ force: true });
});
chrome.notifications.onClicked.addListener(id => {
  if (id === "ophardt-challenge") chrome.tabs.create({ url: `${BASE}/en/search/rankings/${FEDERATION_ID}` });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "syncNow") { syncNow({ force: true }).then(() => reply({ done: true })); return true; }
});
