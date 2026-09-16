#!/usr/bin/env python
"""Check whether the catalogue enumeration can see the giveaway at all.

The first full sweep published 7994 deals but the audit still showed the
giveaway arriving through the watchlist, which means the enumeration never
offered its appid. This confirms that directly.
"""

from __future__ import annotations

import importlib.util
import os
import re
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("sync_deals", Path(__file__).with_name("sync_deals.py"))
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)

APPIDS = [int(p) for p in re.findall(r"\d+", os.environ.get("DIAGNOSE_APPIDS", "447700"))]

appids = sync_deals.enumerate_catalog_appids()
present = sorted(set(APPIDS) & set(appids))
neighbours = [a for a in appids if abs(a - APPIDS[0]) < 600] if APPIDS else []

print("=" * 72)
print("CAN THE CATALOGUE ENUMERATION SEE THE GIVEAWAY")
print("=" * 72)
print(f"appids enumerated : {len(appids)}")
print(f"lowest / highest  : {appids[0] if appids else None} / {appids[-1] if appids else None}")
print(f"targets present   : {present}")
print(f"targets missing   : {sorted(set(APPIDS) - set(appids))}")
print(f"neighbours within 600 of {APPIDS[0] if APPIDS else None}: {neighbours[:20]}")
print()
print("If the target is missing while its neighbours are listed, the query")
print("service hides currently-free apps exactly as the store search does,")
print("and no sweep built on it can discover a giveaway on its own.")
