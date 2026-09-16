#!/usr/bin/env python
"""Measure whether full-catalogue discount coverage is feasible.

The watchlist only finds giveaways someone already knows about. General coverage
needs every app's purchase option, so this measures the two costs that decide it:
how many appids GetItems accepts per request, and how cheaply the full appid list
can be enumerated.
"""

from __future__ import annotations

import importlib.util
import json
import time
import urllib.parse
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("sync_deals", Path(__file__).with_name("sync_deals.py"))
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)

QUERY_URL = "https://api.steampowered.com/IStoreQueryService/Query/v1/"


def enumerate_ids(count: int) -> tuple[int, list[int], float, int]:
    payload = {
        "query": {"filters": {}, "start": 0, "count": count},
        "context": {"language": "russian", "country_code": "RU"},
        "data_request": {},
    }
    url = f"{QUERY_URL}?{urllib.parse.urlencode({'input_json': json.dumps(payload, separators=(',', ':'))})}"
    began = time.monotonic()
    raw = sync_deals.fetch(url)
    response = json.loads(raw.decode("utf-8-sig")).get("response", {})
    ids = [int(entry.get("appid") or 0) for entry in response.get("ids", [])]
    total = int((response.get("metadata") or {}).get("total_matching_records") or 0)
    return total, ids, time.monotonic() - began, len(raw)


print("=" * 72)
print("HOW MANY APPIDS CAN BE ENUMERATED PER REQUEST")
print("=" * 72)
enumerated = 0
for count in (1000, 5000, 10000):
    try:
        total, ids, seconds, size = enumerate_ids(count)
        enumerated = max(enumerated, len(ids))
        print(f"  count={count:6} -> returned {len(ids):6} of {total} in {seconds:.2f}s, {size/1024:.0f} KiB")
    except Exception as error:
        print(f"  count={count:6} -> ERROR {str(error)[:200]}")

print("\n" + "=" * 72)
print("HOW MANY APPIDS CAN GetItems PRICE PER REQUEST")
print("=" * 72)
_, sample, _, _ = enumerate_ids(1000)
sample = [appid for appid in sample if appid > 0]
priced = 0
for size in (50, 200, 500, 1000):
    batch = sample[:size]
    if len(batch) < size:
        print(f"  batch={size:5} -> skipped, only {len(batch)} sample ids available")
        continue
    payload = {
        "ids": [{"appid": appid} for appid in batch],
        "context": {"language": "russian", "country_code": "RU"},
        "data_request": {"include_all_purchase_options": True},
    }
    url = f"{sync_deals.BROWSE_URL}?{urllib.parse.urlencode({'input_json': json.dumps(payload, separators=(',', ':'))})}"
    try:
        began = time.monotonic()
        raw = sync_deals.fetch(url)
        seconds = time.monotonic() - began
        items = json.loads(raw.decode("utf-8-sig")).get("response", {}).get("store_items", [])
        discounted = sum(1 for i in items
                         if int((i.get("best_purchase_option") or {}).get("discount_pct") or 0) > 0)
        priced = max(priced, len(items))
        print(f"  batch={size:5} -> {len(items):5} items, {discounted:4} discounted, "
              f"{seconds:.2f}s, {len(raw)/1024:.0f} KiB")
    except Exception as error:
        print(f"  batch={size:5} -> ERROR {str(error)[:200]}")

print("\n" + "=" * 72)
print("PROJECTED COST OF FULL COVERAGE")
print("=" * 72)
total, _, _, _ = enumerate_ids(100)
if enumerated and priced:
    print(f"  catalogue size        : {total}")
    print(f"  enumeration requests  : {-(-total // enumerated)} at {enumerated} ids each")
    print(f"  pricing requests      : {-(-total // priced)} at {priced} apps each")
    print(f"  pricing wall clock    : roughly {(-(-total // priced)) * 0.5 / 60:.0f} min at 0.5s per request")
else:
    print("  could not measure both limits")
