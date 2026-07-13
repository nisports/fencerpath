#!/usr/bin/env python3
"""
scrape_ophardt_results.py
─────────────────────────
Scrape per-competition placements & points for ALL Swedish fencers
from the public Ophardt Online ranking pages (no login required).

How it works
────────────
Each ranking show-page at /en/search/rankings/show/{id} contains:
  • A meta table  → weapon / gender / age category
  • A main table  → one column per qualifying competition, one row per athlete
  • Inline modals → per-athlete breakdown: placement, points, competition, date

Output: ophardt_results.json  (next to this script)
Import that file via the tool's Settings → "Import results" button.

Usage
─────
  python3 scrape_ophardt_results.py            # SWE federation, 2025 season
  python3 scrape_ophardt_results.py --season=2024
  python3 scrape_ophardt_results.py --fed=3 --season=2025 --throttle=300
  python3 scrape_ophardt_results.py --id=21574  # single ranking page (debug)
"""

import urllib.request, urllib.error
import re, json, time, sys, os
from html import unescape
from datetime import datetime, date

# ── CLI args ──────────────────────────────────────────────────────────────────
args = {}
for a in sys.argv[1:]:
    m = re.match(r'^--([^=]+)=(.*)$', a)
    if m:
        args[m.group(1)] = m.group(2)
    else:
        args[a.lstrip('-')] = True

FED_ID   = args.get('fed', '3')          # 3 = Svenska Fäktförbundet
SEASON   = args.get('season', str(date.today().year if date.today().month >= 8 else date.today().year - 1))
THROTTLE = int(args.get('throttle', 350))
ONLY_ID  = args.get('id', None)
QUIET    = 'quiet' in args

def log(*a):
    if not QUIET:
        print(*a, flush=True)

# ── HTTP helper ───────────────────────────────────────────────────────────────
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; FencerPath SWE-results scraper)',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en,sv;q=0.8',
}

def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read(500000).decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        log(f"  HTTP {e.code} → {url}")
        return None
    except Exception as e:
        log(f"  ERR {e} → {url}")
        return None

def strip_tags(html):
    return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', ' ', html or ''))).strip()

# ── Parse date "DD.MM.YYYY" → "YYYY-MM-DD" ────────────────────────────────────
def parse_date(d):
    m = re.match(r'(\d{1,2})\.(\d{1,2})\.(\d{4})', d.strip())
    if m:
        return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"
    return d.strip()

# ── Normalize weapon / gender / age ──────────────────────────────────────────
WEAPON_MAP = {'epee': 'epee', 'foil': 'foil', 'sabre': 'sabre', 'säbel': 'sabre',
              'degen': 'epee', 'florett': 'foil'}
AGE_MAP    = {'u13': 'u13', 'u15': 'u15', 'u17': 'u17', 'u20': 'u20', 'u23': 'u23',
              'senior': 'senior', 'veteran': 'veteran', 'cadet': 'u17', 'junior': 'u20'}
def parse_meta(html):
    """Extract weapon, gender, age from the first meta table."""
    text = strip_tags(html).lower()
    weapon = next((WEAPON_MAP[k] for k in WEAPON_MAP if k in text), None)
    # Check women's BEFORE men's — "men's" is a substring of "women's"
    if any(k in text for k in ("women's", "women", "female", "dam")):
        gender = 'F'
    elif any(k in text for k in ("men's", "men", "male", "herr")):
        gender = 'M'
    else:
        gender = None
    age = next((AGE_MAP[k] for k in AGE_MAP if re.search(r'\b' + k + r'\b', text)), None)
    return weapon, gender, age

# ── Parse one ranking show page ───────────────────────────────────────────────
def parse_ranking_page(rid, body):
    tables = re.findall(r'<table[^>]*>(.*?)</table>', body, re.DOTALL | re.IGNORECASE)
    if len(tables) < 2:
        return None

    weapon, gender, age = parse_meta(tables[0])
    if not weapon:
        log(f"  [skip] no weapon found in meta for ranking {rid}")
        return None

    log(f"  weapon={weapon} gender={gender} age={age}")

    # ── Competition columns (from header row) ────────────────────────────────
    comp_cols = []
    col_headers = re.findall(
        r'<th[^>]*ranking-rotate[^>]*>.*?href="#comp-(\d+)"[^>]*>\s*([\d.]+)\s+([^<\n]+?)\s*<br\s*/?>(.*?)</a>',
        tables[1], re.DOTALL | re.IGNORECASE
    )
    for mc_id, raw_date, location, raw_name in col_headers:
        city = re.sub(r'\s*\([^)]*\)', '', location).strip()   # remove "(U15)" etc
        comp_cols.append({
            'masterCompId': int(mc_id),
            'date': parse_date(raw_date),
            'city': unescape(city.strip()),
            'name': unescape(raw_name.strip()),
        })

    # ── Athlete rows ─────────────────────────────────────────────────────────
    athletes = []
    # Match rows: overall rank | points | transferred-pts | name-cell | nation | ...
    athlete_blocks = re.findall(
        r'<tr>\s*<td class="ranking">\s*(\d+)\s*</td>\s*'
        r'<td class="ranking">\s*([\d.]+)\s*</td>\s*'
        r'<td class="ranking">\s*([\d.]+)\s*</td>\s*'
        r'<td class="ranking">(.*?)</td>\s*'
        r'<td class="ranking">(.*?)</td>',
        body, re.DOTALL
    )

    for overall_rank, total_pts, tp, name_cell, nation_cell in athlete_blocks:
        # Extract athlete name and Ophardt athlete ID
        name_m = re.search(
            r'data-toggle="dropdown"[^>]*>\s*([A-ZÁÀÄÅÖÜ][^\n<]+?)\s*</a>',
            name_cell
        )
        if not name_m:
            continue
        raw_name = unescape(name_m.group(1).strip())

        id_m = re.search(r'/en/biography/athlete/(\d+)', name_cell)
        athlete_id = int(id_m.group(1)) if id_m else None

        nation = strip_tags(nation_cell)

        # Extract per-competition details from inline modal
        comp_results = []
        if athlete_id:
            modal_m = re.search(
                r'id="info-' + str(athlete_id) + r'".*?<table[^>]*>(.*?)</table>',
                body, re.DOTALL
            )
            if modal_m:
                rows = re.findall(r'<tr>(.*?)</tr>', modal_m.group(1), re.DOTALL)
                for tr in rows[1:]:   # skip header
                    tds = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.DOTALL)
                    if len(tds) >= 5:
                        placement_str = strip_tags(tds[0])
                        pts_str       = strip_tags(tds[1])
                        comp_name     = unescape(strip_tags(tds[2]))
                        city_raw      = strip_tags(tds[3])
                        date_str      = parse_date(strip_tags(tds[4]))
                        city_clean    = re.sub(r'\s*\([^)]*\)', '', city_raw).strip()  # remove "(SWE)"
                        try:
                            comp_results.append({
                                'placement': int(placement_str),
                                'points':    float(pts_str) if pts_str else 0,
                                'compName':  comp_name,
                                'city':      city_clean,
                                'date':      date_str,
                            })
                        except ValueError:
                            pass

        athletes.append({
            'athleteId':   athlete_id,
            'name':        raw_name,
            'nation':      nation,
            'overallRank': int(overall_rank),
            'totalPoints': float(total_pts),
            'results':     comp_results,
        })

    return {
        'rankingId': int(rid),
        'weapon':    weapon,
        'gender':    gender,
        'age':       age,
        'season':    SEASON,
        'competitions': comp_cols,
        'athletes':     athletes,
    }

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if ONLY_ID:
        ranking_ids = [ONLY_ID]
    else:
        log(f"Fetching ranking index: federation={FED_ID} season={SEASON} ...")
        index_html = fetch(f'https://fencing.ophardt.online/en/search/rankings/{FED_ID}?season={SEASON}')
        if not index_html:
            print("ERROR: Could not load ranking index page.", file=sys.stderr)
            sys.exit(1)
        ranking_ids = list(dict.fromkeys(
            re.findall(r'/en/search/rankings/show/(\d+)', index_html)
        ))
        log(f"Found {len(ranking_ids)} ranking pages.")

    all_rankings = []
    for i, rid in enumerate(ranking_ids, 1):
        log(f"[{i}/{len(ranking_ids)}] Fetching ranking {rid} ...")
        url = f'https://fencing.ophardt.online/en/search/rankings/show/{rid}'
        html = fetch(url)
        if not html:
            continue
        result = parse_ranking_page(rid, html)
        if result:
            n_athletes  = len(result['athletes'])
            n_results   = sum(len(a['results']) for a in result['athletes'])
            log(f"    → {n_athletes} athletes, {n_results} competition results")
            all_rankings.append(result)
        if i < len(ranking_ids):
            time.sleep(THROTTLE / 1000)

    # ── Deduplicate: same athlete may appear across rankings (e.g. national + vmem)
    # Build flat list: { athleteId, name, nation, discipline:{weapon,gender,age},
    #                    results:[{placement,points,compName,city,date}] }
    output = {
        'scrapedAt': datetime.utcnow().isoformat() + 'Z',
        'source':    'fencing.ophardt.online',
        'federation': FED_ID,
        'season':    SEASON,
        'rankings':  all_rankings,
    }

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ophardt_results.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    total_athletes = sum(len(r['athletes']) for r in all_rankings)
    total_results  = sum(len(a['results']) for r in all_rankings for a in r['athletes'])
    print(f"\n✓ Saved {out_path}")
    print(f"  {len(all_rankings)} rankings · {total_athletes} athlete-entries · {total_results} competition results")
    print(f"  Import via: Settings → Import results (ophardt_results.json)")

if __name__ == '__main__':
    main()
