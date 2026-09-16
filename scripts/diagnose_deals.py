#!/usr/bin/env python
"""Hunt for a Steam source that lists free-to-keep promotions.

Store search returns nothing for them, so this probes alternative discovery
endpoints. Runs in CI, where Steam is reachable. Output is compact and printed
at the end of the job so it survives log tailing.
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
TARGET = set(APPIDS)
CAP = 900


def clip(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= CAP else text[:CAP] + f"…(+{len(text) - CAP} chars)"


def search(**overrides) -> dict:
    params = {"query": "", "start": 0, "count": 100, "dynamic_data": "",
              "supportedlang": "russian", "cc": "ru", "ndl": 1, "infinite": 1}
    params.update(overrides)
    return sync_deals.fetch_json(f"{sync_deals.SEARCH_URL}?{urllib.parse.urlencode(params)}")


print("=" * 72)
print("PROBE 1 — paginate the free price facet, is the app simply deeper in")
print("=" * 72)
try:
    first = search(maxprice="free")
    total = int(first.get("total_count", 0))
    print(f"maxprice=free total_count: {total}")
    found_at = None
    for start in range(0, min(total, 1000), 100):
        html = search(maxprice="free", start=start).get("results_html", "")
        hit = [a for a in APPIDS if re.search(rf'data-ds-appid="{a}"', html)]
        if hit:
            found_at = start
            print(f"  FOUND {hit} at start={start}")
            break
    if found_at is None:
        print(f"  not found in the first {min(total, 1000)} free entries")
except Exception as error:
    print(f"ERROR {error}")

print("\n" + "=" * 72)
print("PROBE 2 — specials sorted by discount, what is the top discount")
print("=" * 72)
for sort_by in ("Discount_DESC", "Price_ASC"):
    try:
        rows = sync_deals.parse_rows(search(specials=1, sort_by=sort_by).get("results_html", ""))
        top = sorted((r["discountPercent"] for r in rows), reverse=True)[:5]
        print(f"  sort_by={sort_by:14} rows={len(rows):3} top discounts={top}")
    except Exception as error:
        print(f"  sort_by={sort_by:14} ERROR {error}")

print("\n" + "=" * 72)
print("PROBE 3 — IStoreQueryService/Query filter shapes")
print("=" * 72)
SHAPES = {
    "no filter, discount sort": {"filters": {}, "sort": 12},
    "free_to_keep flag":        {"filters": {"store_filters": [{"free_to_keep": True}]}},
    "only free items":          {"filters": {"price_filters": {"only_free_items": True}}},
    "on sale flag":             {"filters": {"store_filters": [{"is_on_sale": True}]}},
}
for label, query in SHAPES.items():
    payload = {"query": {**query, "start": 0, "count": 20},
               "context": {"language": "russian", "country_code": "RU"},
               "data_request": {"include_assets": False, "include_all_purchase_options": True}}
    url = ("https://api.steampowered.com/IStoreQueryService/Query/v1/?"
           + urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))}))
    try:
        response = sync_deals.fetch_json(url).get("response", {})
        ids = [int(i.get("appid") or 0) for i in response.get("store_items", [])]
        print(f"  {label:20} keys={sorted(response.keys())} ids[:8]={ids[:8]} target={sorted(TARGET & set(ids))}")
    except Exception as error:
        print(f"  {label:20} ERROR {clip(str(error))}")

print("\n" + "=" * 72)
print("PROBE 4 — legacy appdetails for the target")
print("=" * 72)
for appid in APPIDS:
    url = f"{sync_deals.DETAIL_URL}?appids={appid}&cc=ru&l=russian"
    try:
        data = sync_deals.fetch_json(url).get(str(appid), {})
        body = data.get("data", {})
        print(f"  {appid}: success={data.get('success')} is_free={body.get('is_free')}")
        print(f"     price_overview = {clip(body.get('price_overview'))}")
        print(f"     package_groups[0] = {clip((body.get('package_groups') or [{}])[0])}")
    except Exception as error:
        print(f"  {appid}: ERROR {clip(str(error))}")
