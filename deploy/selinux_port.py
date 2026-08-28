#!/usr/bin/env python3
import re
import subprocess
import sys

ALLOWED_BASE_TYPES = {"http_port_t", "unreserved_port_t"}


def matching_entries(text, port):
    matches = []
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 3 or "tcp" not in fields:
            continue
        selinux_type = fields[0]
        for value in "".join(fields[2:]).split(","):
            if not value:
                continue
            bounds = value.split("-", 1)
            if not all(re.fullmatch(r"[0-9]+", bound) for bound in bounds):
                continue
            low, high = int(bounds[0]), int(bounds[-1])
            if low <= port <= high:
                matches.append((selinux_type, low == high == port))
    return matches


def listing(*args):
    result = subprocess.run(
        ["semanage", "port", *args, "-l"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "semanage listing failed")
    return result.stdout


def classify(full_text, local_text, port):
    full = matching_entries(full_text, port)
    local = matching_entries(local_text, port)
    if local:
        if all(kind == "http_port_t" and exact for kind, exact in local):
            return "ready"
        raise ValueError("conflicting local SELinux port mapping")
    types = {kind for kind, _ in full}
    if "http_port_t" in types and types <= ALLOWED_BASE_TYPES:
        return "ready"
    if types == {"unreserved_port_t"}:
        return "add"
    raise ValueError("conflicting or missing SELinux port mapping")


def ownership(local_text, port):
    local = matching_entries(local_text, port)
    if not local:
        return "absent"
    if all(kind == "http_port_t" and exact for kind, exact in local):
        return "owned"
    raise ValueError("conflicting local SELinux port mapping")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"classify", "verify-owned", "ownership"}:
        raise SystemExit("usage: selinux_port.py classify|verify-owned|ownership PORT")
    action = sys.argv[1]
    try:
        port = int(sys.argv[2])
        if not 1 <= port <= 65535:
            raise ValueError("invalid port")
        local_text = listing("-C")
        if action == "classify":
            print(classify(listing(), local_text, port))
        else:
            state = ownership(local_text, port)
            if action == "verify-owned" and state != "owned":
                raise ValueError("exact installer-owned SELinux label is absent")
            print(state)
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
