#!/usr/bin/env python
from pathlib import Path
import re
import sys

SITE = Path(__file__).resolve().parents[1] / "site"
ALLOWED = {"index.html", "styles.css", "favicon.svg", ".nojekyll"}
SENSITIVE = [
    re.compile(r"(?i)(google_client_secret|steam_key_encryption_secret)\s*[=:]\s*[^.\s<]"),
    re.compile(r"(?i)api[_-]?key\s*[=:]\s*[A-F0-9]{24,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]

files = {str(path.relative_to(SITE)).replace("\\", "/") for path in SITE.rglob("*") if path.is_file()}
if files != ALLOWED:
    raise SystemExit(f"Unexpected Pages artifact files: {sorted(files ^ ALLOWED)}")

html = (SITE / "index.html").read_text(encoding="utf-8")
text_artifact = "\n".join(
    (SITE / name).read_text(encoding="utf-8")
    for name in sorted(ALLOWED)
)
for pattern in SENSITIVE:
    if pattern.search(text_artifact):
        raise SystemExit(f"Sensitive pattern found: {pattern.pattern}")

required = [
    "https://github.com/mdanshin/steam-shelf",
    "GitHub Pages не хранит секреты и не выполняет Node.js",
    "git clone https://github.com/mdanshin/steam-shelf.git",
    "Content-Security-Policy",
]
missing = [value for value in required if value not in html]
if missing:
    raise SystemExit(f"Missing required Pages content: {missing}")

root_relative = re.compile(
    r"(?:src|href)\s*=\s*[\"']/(?!/)|url\(\s*[\"']?/(?!/)",
    re.IGNORECASE,
)
if root_relative.search(text_artifact):
    raise SystemExit("Root-relative asset URL is incompatible with project Pages")

print(f"Pages artifact verified: {len(files)} files")
