#!/usr/bin/env python
"""Find a bulk source of Steam review scores, to filter weak games out.

Review data today comes only from scraped Specials rows, so entries the
catalogue sweep found carry none. This checks whether the store item endpoint
can return reviews, and what the dedicated reviews endpoint costs per app.
"""

from __future__ import annotations

import importlib.util
import json
import re
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("sync_deals", Path(__file__).with_name("sync_deals.py"))
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)

SAMPLE = [447700, 570, 730, 1091500, 892970, 2000040, 1245620, 271590]
CAP = 700


def clip(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= CAP else text[:CAP] + f"…(+{len(text) - CAP} chars)"


print("=" * 72)
print("A — can GetItems return review data at all")
print("=" * 72)
for label, extra in {
    "include_reviews": {"include_reviews": True},
    "include_review_score": {"include_review_score": True},
    "include_basic_info": {"include_basic_info": True},
}.items():
    payload = {
        "ids": [{"appid": 570}],
        "context": {"language": "russian", "country_code": "RU"},
        "data_request": {"include_all_purchase_options": True, **extra},
    }
    params = urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))})
    try:
        items = sync_deals.fetch_json(f"{sync_deals.BROWSE_URL}?{params}").get("response", {}).get("store_items", [])
        keys = sorted(items[0].keys()) if items else []
        review_keys = [k for k in keys if "review" in k.lower()]
        print(f"  {label:22} keys with 'review': {review_keys or 'none'}")
    except Exception as error:
        print(f"  {label:22} ERROR {clip(str(error))}")

print("\n" + "=" * 72)
print("B — the dedicated reviews endpoint, shape and cost")
print("=" * 72)


def review_summary(appid: int) -> tuple[int, dict]:
    url = (f"https://store.steampowered.com/appreviews/{appid}"
           f"?json=1&language=all&purchase_type=all&num_per_page=0")
    return appid, sync_deals.fetch_json(url).get("query_summary", {})


began = time.monotonic()
summaries = dict(ThreadPoolExecutor(max_workers=4).map(review_summary, SAMPLE))
elapsed = time.monotonic() - began
for appid, summary in summaries.items():
    print(f"  {appid}: {clip(summary)}")
print(f"\n  {len(SAMPLE)} apps in {elapsed:.2f}s with 4 workers "
      f"-> {len(SAMPLE)/elapsed:.1f} apps/s")
print(f"  projected for 8000 published deals: {8000/max(len(SAMPLE)/elapsed, 0.01)/60:.1f} min")

print("\n" + "=" * 72)
print("C — how much of the published catalogue already has a rating")
print("=" * 72)
import urllib.request
request = urllib.request.Request("https://mdanshin.github.io/steam-shelf/deals-data.js",
                                 headers={"User-Agent": "steam-shelf-verify"})
with urllib.request.urlopen(request, timeout=60) as response:
    source = response.read(20 * 1024 * 1024).decode("utf-8")
catalog = json.loads(source[source.index("dealsCatalog =") + len("dealsCatalog ="):].strip().rstrip(";\n"))
rated = [g for g in catalog if g.get("reviewPercent") is not None]
print(f"  entries: {len(catalog)}, with a rating: {len(rated)}, without: {len(catalog) - len(rated)}")
if rated:
    percents = sorted(g["reviewPercent"] for g in rated)
    counts = sorted(g["reviewCount"] for g in rated if g.get("reviewCount"))
    print(f"  reviewPercent quartiles: {percents[len(percents)//4]}, {percents[len(percents)//2]}, {percents[3*len(percents)//4]}")
    print(f"  reviewCount  quartiles: {counts[len(counts)//4]}, {counts[len(counts)//2]}, {counts[3*len(counts)//4]}")
    print(f"  would pass the existing quality rule: {sum(sync_deals.quality_pass(g['reviewPercent'], g['reviewCount']) for g in rated)}")
