#!/usr/bin/env python
"""Find which Steam query surfaces a given app, and what its search row looks like.

Runs inside CI, where Steam is reachable. Output is compact and printed at the
end of the job so it survives log tailing.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import urllib.parse
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("sync_deals", Path(__file__).with_name("sync_deals.py"))
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)

APPIDS = [int(part) for part in re.findall(r"\d+", os.environ.get("DIAGNOSE_APPIDS", "447700"))]
TERM = os.environ.get("DIAGNOSE_TERM", "Crystal Crisis")
CAP = 1400

BASE = {
    "query": "", "start": 0, "count": 100, "dynamic_data": "",
    "supportedlang": "russian", "cc": "ru", "ndl": 1, "infinite": 1,
}

QUERIES = {
    "specials only":            {"specials": 1, "sort_by": "_ASC"},
    "specials, cheapest first": {"specials": 1, "sort_by": "Price_ASC"},
    "term + specials":          {"specials": 1, "term": TERM},
    "term, no specials key":    {"term": TERM},
    "maxprice=free":            {"maxprice": "free"},
    "maxprice=free + specials": {"maxprice": "free", "specials": 1},
    "maxprice=free, term":      {"maxprice": "free", "term": TERM},
}


def clip(text: str) -> str:
    return text if len(text) <= CAP else text[:CAP] + f"…(+{len(text) - CAP} chars)"


def fetch_html(overrides: dict) -> str:
    params = dict(BASE)
    params.update(overrides)
    url = f"{sync_deals.SEARCH_URL}?{urllib.parse.urlencode(params)}"
    return sync_deals.fetch_json(url).get("results_html", "")


def row_markup(html: str, appid: int) -> str | None:
    match = re.search(rf'<a\b[^>]*data-ds-appid="{appid}"[^>]*>[\s\S]*?</a>', html)
    return match.group(0) if match else None


print("=" * 72)
print("WHICH QUERY RETURNS THE APP AT ALL (raw HTML, before any parsing)")
print("=" * 72)
found_in = {}
for label, overrides in QUERIES.items():
    try:
        html = fetch_html(overrides)
    except Exception as error:  # a rejected query is itself a finding
        print(f"{label:26} ERROR {error}")
        continue
    anchors = len(re.findall(r'data-ds-appid="', html))
    hits = [appid for appid in APPIDS if row_markup(html, appid)]
    parsed = sync_deals.parse_rows(html)
    found_in[label] = (html, hits)
    print(f"{label:26} anchors={anchors:3}  parse_rows={len(parsed):3}  target rows present: {hits}")

print("\n" + "=" * 72)
print("RAW SEARCH ROW FOR THE TARGET, WHEREVER IT WAS FOUND")
print("=" * 72)
for label, (html, hits) in found_in.items():
    for appid in hits:
        markup = row_markup(html, appid)
        print(f"\n--- {label} / appid {appid} ---")
        print(clip(markup))
        print(f"has discount_pct block: {bool(re.search(r'discount_pct', markup))}")
        print(f"parse_rows keeps it   : {any(r['appid'] == appid for r in sync_deals.parse_rows(markup))}")

print("\n" + "=" * 72)
print("FEATURED CATEGORIES API")
print("=" * 72)
try:
    featured = sync_deals.fetch_json("https://store.steampowered.com/api/featuredcategories?cc=ru&l=russian")
    print(f"sections: {sorted(featured.keys())}")
    for name, section in featured.items():
        if not isinstance(section, dict):
            continue
        items = section.get("items") or []
        ids = {int(entry.get("id") or 0) for entry in items if isinstance(entry, dict)}
        hit = sorted(set(APPIDS) & ids)
        print(f"  {name:22} items={len(items):3} target present: {hit}")
except Exception as error:
    print(f"ERROR {error}")
