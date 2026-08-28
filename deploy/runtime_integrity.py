#!/usr/bin/env python3
import hashlib
import json
import os
import pathlib
import stat
import sys

MANIFEST = ".steam-shelf-integrity.json"


def entries(runtime):
    result = {}
    for path in sorted(runtime.rglob("*")):
        relative = path.relative_to(runtime).as_posix()
        if relative == MANIFEST:
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(runtime):
                raise SystemExit(f"runtime symlink escapes: {relative}")
            result[relative] = {"kind": "link", "target": target}
        elif stat.S_ISDIR(info.st_mode):
            result[relative] = {"kind": "directory"}
        elif stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            result[relative] = {"kind": "file", "sha256": digest.hexdigest()}
        else:
            raise SystemExit(f"unsupported runtime object: {relative}")
    return result


def verify_metadata(runtime):
    for path in [runtime, *runtime.rglob("*")]:
        info = path.lstat()
        if info.st_uid != 0 or info.st_gid != 0:
            raise SystemExit(f"runtime owner is not root: {path}")
        if not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022:
            raise SystemExit(f"runtime object is writable outside root: {path}")


if len(sys.argv) not in {3, 4} or sys.argv[1] not in {"create", "verify"}:
    raise SystemExit("usage: runtime_integrity.py create RUNTIME | verify RUNTIME RUNTIME_ROOT")
mode = sys.argv[1]
runtime = pathlib.Path(sys.argv[2]).resolve(strict=True)
if mode == "create":
    manifest = runtime / MANIFEST
    if manifest.exists():
        raise SystemExit("runtime manifest already exists")
    manifest.write_text(json.dumps({"version": 1, "entries": entries(runtime)}, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
else:
    root = pathlib.Path(sys.argv[3]).resolve(strict=True)
    if runtime.parent != root:
        raise SystemExit("runtime is outside the approved runtime root")
    verify_metadata(runtime)
    manifest = runtime / MANIFEST
    info = manifest.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit("runtime manifest is not a regular file")
    expected = json.loads(manifest.read_text(encoding="utf-8"))
    if expected != {"version": 1, "entries": entries(runtime)}:
        raise SystemExit("runtime integrity mismatch")
