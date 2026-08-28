#!/usr/bin/env python
from pathlib import Path
import re
import sys

SITE = Path(__file__).resolve().parents[1] / "site"
ALLOWED = {
    "index.html",
    "styles.css",
    "favicon.svg",
    ".nojekyll",
    "app.js",
    "deals-data.js",
    "firebase-config.js",
    "privacy.html",
    "terms.html",
}
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
    "Продолжить с Google",
    "сохраняются только в IndexedDB этого браузера",
    "Ключ передаётся защищённому gateway только во время ручной синхронизации",
    "https://api.danshin.ms",
    "https://store.steampowered.com/account/",
    "https://steamcommunity.com/dev/apikey",
    "./privacy.html",
    "./terms.html",
    "Content-Security-Policy",
    "script-src 'self' https://apis.google.com",
]
missing = [value for value in required if value not in html]
if missing:
    raise SystemExit(f"Missing required Pages content: {missing}")

root_relative = re.compile(
    r"(?:src|href)\s*=\s*[\"']/(?!/)|url\(\s*[\"']?/(?!/)",
    re.IGNORECASE,
)
path_sensitive_artifacts = "\n".join(
    (SITE / name).read_text(encoding="utf-8")
    for name in ("index.html", "privacy.html", "terms.html", "styles.css")
)
if root_relative.search(path_sensitive_artifacts):
    raise SystemExit("Root-relative asset URL is incompatible with project Pages")

print(f"Pages artifact verified: {len(files)} files")
