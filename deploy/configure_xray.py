#!/usr/bin/env python3
import json
import pathlib
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: configure_xray.py CONFIG")
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
matches = []
for inbound in data.get("inbounds", []):
    if inbound.get("port") != 443 or inbound.get("protocol") != "vless":
        continue
    reality = inbound.get("streamSettings", {}).get("realitySettings", {})
    if reality.get("dest") in {"127.0.0.1:8443", "127.0.0.1:8444"}:
        matches.append(reality)
if len(matches) != 1:
    raise SystemExit("expected one REALITY fallback target")
reality = matches[0]
if reality.get("dest") == "127.0.0.1:8443" and reality.get("xver", 0) != 0:
    raise SystemExit("unexpected xver on the rollback target")
reality["dest"] = "127.0.0.1:8444"
reality["xver"] = 1
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
