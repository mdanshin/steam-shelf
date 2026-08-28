#!/usr/bin/env python3
import pathlib
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: configure_nginx.py CONFIG LOCATION_SNIPPET PROXY_SNIPPET")
config_path, location_path, proxy_path = map(pathlib.Path, sys.argv[1:])
text = config_path.read_text(encoding="utf-8")


def server_blocks(source):
    positions = []
    cursor = 0
    while True:
        start = source.find("server {", cursor)
        if start < 0:
            return positions
        depth = 0
        quoted = None
        escaped = False
        comment = False
        for index in range(start, len(source)):
            char = source[index]
            if comment:
                if char == "\n":
                    comment = False
                continue
            if escaped:
                escaped = False
                continue
            if char == "\\" and quoted:
                escaped = True
                continue
            if char in {'"', "'"}:
                quoted = None if quoted == char else (char if quoted is None else quoted)
                continue
            if quoted:
                continue
            if char == "#":
                comment = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    positions.append((start, index + 1))
                    cursor = index + 1
                    break
        else:
            raise SystemExit("unbalanced nginx server block")


tls_listener = "listen 127.0.0.1:8443 ssl; # managed by Certbot"
matches = [
    (start, end)
    for start, end in server_blocks(text)
    if "server_name api.danshin.ms;" in text[start:end]
    and tls_listener in text[start:end]
]
if len(matches) != 1:
    raise SystemExit("expected one api.danshin.ms TLS backend server")
start, end = matches[0]
block = text[start:end]

location_marker = "    # BEGIN STEAM SHELF GATEWAY\n"
if location_marker not in block:
    target = "    location / {\n"
    if block.count(target) != 1:
        raise SystemExit("expected one catch-all location")
    snippet = "\n".join(f"    {line}" if line else "" for line in location_path.read_text(encoding="utf-8").strip().splitlines())
    insertion = f"{location_marker}{snippet}\n    # END STEAM SHELF GATEWAY\n\n"
    block = block.replace(target, insertion + target, 1)

proxy_marker = "    # BEGIN STEAM SHELF PROXY PROTOCOL\n"
if proxy_marker not in block:
    target = "    listen 127.0.0.1:8443 ssl; # managed by Certbot\n"
    if block.count(target) != 1:
        raise SystemExit("expected one TLS listener")
    snippet = "\n".join(f"    {line}" if line else "" for line in proxy_path.read_text(encoding="utf-8").strip().splitlines())
    insertion = f"{proxy_marker}{snippet}\n    # END STEAM SHELF PROXY PROTOCOL\n\n"
    block = block.replace(target, target + insertion, 1)

config_path.write_text(text[:start] + block + text[end:], encoding="utf-8")
