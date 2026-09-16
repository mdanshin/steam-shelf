#!/usr/bin/env python
"""Inspect IStoreQueryService free-to-keep results, which came back as packages.

Runs in CI, where Steam is reachable. Compact output, printed at the end of the
job so it survives log tailing.
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

APPIDS = [int(p) for p in re.findall(r"\d+", os.environ.get("DIAGNOSE_APPIDS", "447700"))]
QUERY_URL = "https://api.steampowered.com/IStoreQueryService/Query/v1/"
CAP = 1100


def clip(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= CAP else text[:CAP] + f"…(+{len(text) - CAP} chars)"


def query(filters: dict, count: int = 50, extra: dict | None = None) -> dict:
    payload = {
        "query": {"filters": filters, "start": 0, "count": count, **(extra or {})},
        "context": {"language": "russian", "country_code": "RU"},
        "data_request": {"include_assets": False, "include_all_purchase_options": True},
    }
    url = f"{QUERY_URL}?{urllib.parse.urlencode({'input_json': json.dumps(payload, separators=(',', ':'))})}"
    return sync_deals.fetch_json(url).get("response", {})


for label, filters in {
    "free_to_keep": {"store_filters": [{"free_to_keep": True}]},
    "is_on_sale": {"store_filters": [{"is_on_sale": True}]},
}.items():
    print("=" * 72)
    print(f"QUERY store_filters {label}")
    print("=" * 72)
    try:
        response = query(filters)
        print(f"metadata = {clip(response.get('metadata'))}")
        print(f"ids      = {clip(response.get('ids'))}")
        items = response.get("store_items", [])
        print(f"store_items: {len(items)}")
        for item in items[:12]:
            option = item.get("best_purchase_option") or {}
            print(f"  id={item.get('id')} type={item.get('item_type')} appid={item.get('appid')} "
                  f"pkg={item.get('packageid')} name={item.get('name')!r} "
                  f"discount={option.get('discount_pct')} free_to_keep={option.get('is_free_to_keep')}")
        blob = json.dumps(response, ensure_ascii=False)
        for appid in APPIDS:
            print(f"  appid {appid} appears anywhere in this response: {str(appid) in blob}")
        if items:
            print(f"\n  first item raw = {clip(items[0])}")
    except Exception as error:
        print(f"ERROR {clip(str(error))}")
    print()

print("=" * 72)
print("RESOLVE THE TARGET'S PROMOTIONAL PACKAGE THROUGH GetItems")
print("=" * 72)
payload = {
    "ids": [{"packageid": 1821396}],
    "context": {"language": "russian", "country_code": "RU"},
    "data_request": {"include_assets": False, "include_all_purchase_options": True},
}
url = f"{sync_deals.BROWSE_URL}?{urllib.parse.urlencode({'input_json': json.dumps(payload, separators=(',', ':'))})}"
try:
    for item in sync_deals.fetch_json(url).get("response", {}).get("store_items", []):
        print(clip(item))
except Exception as error:
    print(f"ERROR {clip(str(error))}")
