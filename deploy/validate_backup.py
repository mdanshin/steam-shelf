#!/usr/bin/env python3
import pathlib
import re
import stat
import sys

ROOT = pathlib.Path("/opt/steam-shelf-api")
BACKUP_ROOT = pathlib.Path("/var/backups/steam-shelf-api")
CONFIGS = ("xray-config.json", "nginx-api.conf", "gateway.service", "nginx-rate.conf", "active-backup")
REQUIRED = {
    "previous-current", "previous-runtime", "service-enabled", "service-active",
    "root-status", "uvicorn-direct-status", "uvicorn-public-status", "deployment-manifest",
}
OPTIONAL = {"added-http-port-8001", "added-http-port-8444"}


def validate_backup(provided, root=ROOT, backup_root=BACKUP_ROOT, enforce_metadata=True):
    provided = pathlib.Path(provided)
    root = pathlib.Path(root).resolve()
    backup_root = pathlib.Path(backup_root).resolve()
    backup = provided.resolve(strict=True)
    if backup.parent != backup_root or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}", backup.name):
        raise ValueError("backup path is outside the approved backup root")
    info = provided.lstat()
    if enforce_metadata and (stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("backup directory metadata is unsafe")
    names = {path.name for path in backup.iterdir()}
    allowed = REQUIRED | OPTIONAL
    for name in CONFIGS:
        present = name in names
        absent = f"{name}.absent" in names
        if present == absent:
            raise ValueError(f"backup must contain exactly one marker for {name}")
        allowed.update({name, f"{name}.absent"})
    if not REQUIRED <= names or not names <= allowed:
        raise ValueError("backup inventory is incomplete or unexpected")
    for path in backup.iterdir():
        item = path.lstat()
        # The root-owned 0700 backup directory is the trust boundary. Files copied
        # with `cp -a` must retain the original owner/group so rollback can restore
        # exact nginx/Xray/systemd metadata; they still may not be group/world writable.
        if not stat.S_ISREG(item.st_mode) or (enforce_metadata and item.st_mode & 0o022):
            raise ValueError(f"unsafe backup object: {path.name}")
    manifest = dict(line.split("=", 1) for line in (backup / "deployment-manifest").read_text(encoding="utf-8").splitlines())
    if manifest.get("release") != backup.name or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("artifact_sha256", "")):
        raise ValueError("backup manifest does not match directory")
    if (backup / "service-enabled").read_text().strip() not in {"enabled", "disabled"}:
        raise ValueError("unsupported saved service enablement")
    active = (backup / "service-active").read_text().strip()
    if active not in {"active", "inactive"}:
        raise ValueError("unsupported saved service activity")
    for name in ("root-status", "uvicorn-direct-status", "uvicorn-public-status"):
        if not re.fullmatch(r"[1-5][0-9]{2}", (backup / name).read_text().strip()):
            raise ValueError(f"invalid HTTP baseline: {name}")
    for name, parent in (("previous-current", root / "releases"), ("previous-runtime", root / "runtimes")):
        value = (backup / name).read_text().strip()
        if value:
            target = pathlib.Path(value).resolve(strict=True)
            if target.parent != parent:
                raise ValueError(f"saved target outside approved root: {name}")
        elif active == "active":
            raise ValueError(f"active prior service requires {name}")
    return backup


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_backup.py BACKUP_DIRECTORY")
    try:
        validate_backup(sys.argv[1])
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from error
