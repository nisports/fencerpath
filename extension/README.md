# FencerPath Ranking Sync (Chrome-tillägg)

Ophardt visar sedan ~2026-11-03 en Cloudflare-kontroll för icke-webbläsare, så
Vercel-cronjobbet (`api/cron/sync-rankings.mjs`) kan inte längre hämta Svensk Ranking.
Det här tillägget hämtar de 17 rankinglistorna **en gång per dygn i din egen Chrome**
och skickar dem till `POST /api/ingest-rankings`, som sparar dem i `rankings_cache`.

Tillägget löser eller kringgår aldrig Cloudflare-kontrollen. Blir det stoppat visar det
ett orange "!" och en notis. Öppna då en Ophardt-sida själv, så försöker det igen direkt.

## Installation (en gång)

1. **Vercel → Settings → Environment Variables:** lägg till `INGEST_SECRET`
   (lång slumpsträng, t.ex. `openssl rand -hex 32`) och deploya om.
2. **Chrome:** öppna `chrome://extensions`, slå på *Developer mode*, klicka
   *Load unpacked* och välj den här mappen (`extension/`).
3. Klicka på tilläggets ikon, fyll i FencerPath-adressen och samma `INGEST_SECRET`,
   klicka **Spara** och sedan **Synka nu**.

## Drift

- Körs automatiskt när Chrome startar och sedan varje timme. En lyckad synk spärrar
  nya försök i 20 timmar.
- Hämtar en sida i taget med 1,5 s paus, totalt ca 35 anrop per dygn.
- Status och senaste lyckade synk syns i tilläggets popup.
- Parsningen speglar `lib/vmemScraper.mjs`. Ändra båda om Ophardt ändrar sin HTML.
