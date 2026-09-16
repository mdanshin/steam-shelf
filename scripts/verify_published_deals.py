#!/usr/bin/env python
"""Read the deployed deals file and report what actually reached visitors.

Runs in CI, which can reach the published site. Prints a short summary so the
result is readable from a tailed job log.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request

URL = os.environ.get("VERIFY_URL", "https://mdanshin.github.io/steam-shelf/deals-data.js")
APPIDS = [int(part) for part in re.findall(r"\d+", os.environ.get("VERIFY_APPIDS", "447700"))]

request = urllib.request.Request(URL, headers={"User-Agent": "steam-shelf-verify"})
with urllib.request.urlopen(request, timeout=60) as response:
    source = response.read(20 * 1024 * 1024).decode("utf-8")

synced = re.search(r"dealsSyncedAt = (\"[^\"]+\")", source)
audit = re.search(r"dealsAudit = (\{.*?\});", source, re.S)
catalog = json.loads(source[source.index("dealsCatalog =") + len("dealsCatalog ="):].strip().rstrip(";\n"))

print(f"url            : {URL}")
print(f"dealsSyncedAt  : {json.loads(synced.group(1)) if synced else 'missing'}")
print(f"dealsAudit     : {audit.group(1) if audit else 'missing'}")
print(f"entries        : {len(catalog)}")

by_appid = {int(game['appid']): game for game in catalog}
full = [game for game in catalog if int(game.get("discountPercent") or 0) >= 100]
print(f"entries at 100%: {len(full)} -> {[(g['appid'], g['name']) for g in full[:10]]}")
print(f"max discount   : {max((int(g['discountPercent']) for g in catalog), default=None)}")
print(f"min priceMinor : {min((int(g['priceMinor']) for g in catalog), default=None)}")

for appid in APPIDS:
    game = by_appid.get(appid)
    print(f"\nappid {appid}: {'PRESENT' if game else 'MISSING'}")
    if game:
        print(f"  {json.dumps({k: v for k, v in game.items() if k != 'genres'}, ensure_ascii=False)}")
