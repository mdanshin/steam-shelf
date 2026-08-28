#!/usr/bin/env python3
import pathlib
import sys
import tarfile

ALLOWED_FILES = {
    "gateway/package.json",
    "gateway/package-lock.json",
    "gateway/server.js",
    "functions/steam-sync.js",
}
MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024

if len(sys.argv) != 2:
    raise SystemExit("usage: validate_artifact.py ARTIFACT_TAR_GZ")
artifact = pathlib.Path(sys.argv[1])
files = set()
total = 0
with tarfile.open(artifact, "r:gz") as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
            raise SystemExit("unsafe artifact member")
        normalized = str(path)
        if member.isdir() and normalized in {"gateway", "functions"}:
            continue
        if not member.isfile() or normalized not in ALLOWED_FILES:
            raise SystemExit(f"unexpected artifact member: {normalized}")
        files.add(normalized)
        total += member.size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise SystemExit("artifact is too large")
if files != ALLOWED_FILES:
    raise SystemExit(f"incomplete artifact: {sorted(ALLOWED_FILES - files)}")
