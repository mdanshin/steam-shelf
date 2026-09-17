#!/usr/bin/env python
"""Measure Steam's throttling before choosing a concurrency level.

The full sweep takes 1.74s per request against 0.5s measured for a single one,
which points at throttling rather than latency. If that is right, parallelism
buys nothing and only adds retries, so this measures throughput and rejection
rate at several concurrency levels instead of assuming.
"""

from __future__ import annotations

import importlib.util
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("sync_deals", Path(__file__).with_name("sync_deals.py"))
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)

QUERY_URL = "https://api.steampowered.com/IStoreQueryService/Query/v1/"
REQUESTS_PER_LEVEL = 40


def sample_appids(count: int) -> list[int]:
    payload = {"query": {"filters": {}, "start": 0, "count": count},
               "context": {"language": "russian", "country_code": "RU"}, "data_request": {}}
    params = urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))})
    response = sync_deals.fetch_json(f"{QUERY_URL}?{params}").get("response", {})
    return [int(e.get("appid") or 0) for e in response.get("ids", []) if int(e.get("appid") or 0) > 0]


def price_once(batch: list[int]) -> tuple[str, float]:
    """One GetItems call with no retry, so throttling is visible rather than hidden."""
    payload = {"ids": [{"appid": appid} for appid in batch],
               "context": {"language": "russian", "country_code": "RU"},
               "data_request": {"include_all_purchase_options": True}}
    params = urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))})
    request = urllib.request.Request(f"{sync_deals.BROWSE_URL}?{params}", headers=sync_deals.HEADERS)
    began = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response.read()
            return "ok", time.monotonic() - began
    except urllib.error.HTTPError as error:
        return str(error.code), time.monotonic() - began
    except Exception as error:
        return type(error).__name__, time.monotonic() - began


appids = sample_appids(1000)
batches = [appids[i * 200:(i + 1) * 200] for i in range(REQUESTS_PER_LEVEL)]
batches = [b for b in batches if b] or [appids[:200]]
batches = (batches * REQUESTS_PER_LEVEL)[:REQUESTS_PER_LEVEL]

print("=" * 72)
print(f"THROUGHPUT AT EACH CONCURRENCY LEVEL ({REQUESTS_PER_LEVEL} requests each)")
print("=" * 72)
print(f"{'workers':>8} {'wall s':>8} {'req/s':>7} {'mean s':>7}  outcomes")
for workers in (1, 2, 4, 8):
    began = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(price_once, batches))
    wall = time.monotonic() - began
    outcomes: dict[str, int] = {}
    for status, _ in results:
        outcomes[status] = outcomes.get(status, 0) + 1
    mean = sum(seconds for _, seconds in results) / len(results)
    print(f"{workers:>8} {wall:>8.1f} {len(results)/wall:>7.2f} {mean:>7.2f}  {outcomes}")
    time.sleep(20)  # let any short-window budget refill before the next level

print()
print("If req/s stays flat as workers rise, Steam caps by rate and parallelism")
print("cannot shorten the sweep. If it scales, concurrency is the right fix.")
