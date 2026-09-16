#!/usr/bin/env python
"""Print what Steam actually returns for given apps, to diagnose missing deals.

Runs inside CI, where Steam is reachable. Output is deliberately compact and
printed at the end of the job so it survives log tailing.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse

from pathlib import Path
import importlib.util

SPEC = importlib.util.spec_from_file_location("sync_deals", Path(__file__).with_name("sync_deals.py"))
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)

APPIDS = [int(part) for part in re.findall(r"\d+", os.environ.get("DIAGNOSE_APPIDS", "447700"))]
TERM = os.environ.get("DIAGNOSE_TERM", "Crystal Crisis")
CAP = 1600


def clip(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= CAP else text[:CAP] + f"…(+{len(text) - CAP} chars)"


def search_page(**overrides) -> str:
    params = {
        "query": "", "start": 0, "count": 100, "dynamic_data": "",
        "sort_by": "_ASC", "specials": 1, "supportedlang": "russian",
        "cc": "ru", "ndl": 1, "infinite": 1,
    }
    params.update(overrides)
    payload = sync_deals.fetch_json(f"{sync_deals.SEARCH_URL}?{urllib.parse.urlencode(params)}")
    return payload.get("results_html", "")


print("=" * 72)
print("PROBE A — IStoreBrowseService/GetItems purchase options")
print("=" * 72)
for item in sync_deals.browse_items(APPIDS):
    appid = item.get("appid")
    print(f"\nappid {appid} — {item.get('name')!r}")
    print(f"  type={item.get('type')} visible={item.get('visible')} is_free={item.get('is_free')}")
    print(f"  best_purchase_option = {clip(item.get('best_purchase_option'))}")
    print(f"  purchase_options     = {clip(item.get('purchase_options'))}")
    print(f"  option_prices() -> {sync_deals.option_prices(item.get('best_purchase_option') or {})}")
    print(f"  top level keys: {sorted(item.keys())}")
missing = set(APPIDS) - {int(i.get("appid") or 0) for i in sync_deals.browse_items(APPIDS)}
print(f"\nappids with no store item at all: {sorted(missing)}")

print("\n" + "=" * 72)
print("PROBE B — cheapest Specials first, do any 100% offers exist at all")
print("=" * 72)
rows = sync_deals.parse_rows(search_page(sort_by="Price_ASC"))
full = [r for r in rows if r["discountPercent"] >= 100]
print(f"rows parsed on page 1 (Price_ASC): {len(rows)}")
print(f"rows at 100% off: {len(full)}")
for row in full[:10]:
    print(f"  {row['appid']} {row['name']!r} -{row['discountPercent']}%")
print(f"discount range on this page: {min((r['discountPercent'] for r in rows), default=None)}"
      f"..{max((r['discountPercent'] for r in rows), default=None)}")
print(f"first five rows: {[(r['appid'], r['name'], r['discountPercent']) for r in rows[:5]]}")

print("\n" + "=" * 72)
print(f"PROBE C — Specials search for {TERM!r}")
print("=" * 72)
html_term = search_page(term=TERM)
term_rows = sync_deals.parse_rows(html_term)
print(f"parsed rows: {[(r['appid'], r['name'], r['discountPercent']) for r in term_rows]}")
for appid in APPIDS:
    anchor = re.search(rf'<a\b[^>]*data-ds-appid="{appid}"[^>]*>[\s\S]*?</a>', html_term)
    print(f"\nraw search markup for {appid} present: {bool(anchor)}")
    if anchor:
        print(clip(anchor.group(0)))

print("\n" + "=" * 72)
print("PROBE D — same search without the specials filter")
print("=" * 72)
plain = sync_deals.parse_rows(search_page(term=TERM, specials=0))
print(f"parsed rows: {[(r['appid'], r['name'], r['discountPercent']) for r in plain]}")
