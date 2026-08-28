#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${EUID} -ne 0 || $# -ne 3 ]]; then
  echo "usage: sudo install_gateway.sh RELEASE_ID ARTIFACT_TAR_GZ ARTIFACT_SHA256" >&2
  exit 2
fi
for dependency in ausearch chmod chown cp curl cut date dirname find firewall-cmd flock getenforce getent getsebool groupadd id install ln mkdir mktemp mv nginx python3 readlink restorecon rm semanage sha256sum sleep ss stat sync systemctl systemd-analyze tar touch uname useradd; do
  command -v "$dependency" >/dev/null || { echo "missing deployment dependency: $dependency" >&2; exit 1; }
done
[[ -x /usr/local/bin/xray ]] || { echo "missing deployment dependency: /usr/local/bin/xray" >&2; exit 1; }
RELEASE_ID=$1
ARTIFACT=$2
ARTIFACT_SHA256=$3
[[ "$RELEASE_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || { echo "invalid release id" >&2; exit 2; }
[[ -f "$ARTIFACT" ]] || { echo "artifact not found" >&2; exit 2; }
[[ "$ARTIFACT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid artifact SHA-256" >&2; exit 2; }
[[ $(sha256sum "$ARTIFACT" | cut -d' ' -f1) == "$ARTIFACT_SHA256" ]] || { echo "artifact SHA-256 mismatch" >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo "unsupported architecture" >&2; exit 1; }
[[ $(getenforce) == Enforcing ]] || { echo "SELinux must remain Enforcing" >&2; exit 1; }
[[ $(getsebool httpd_can_network_connect) == *" --> off" ]] || { echo "broad httpd network access must remain disabled" >&2; exit 1; }
read -r DEPLOY_AUDIT_DATE DEPLOY_AUDIT_TIME <<<"$(LC_ALL=C date '+%x %T')"

NODE_VERSION=v24.19.0
NODE_ARCHIVE=node-v24.19.0-linux-x64.tar.xz
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
ROOT=/opt/steam-shelf-api
RUNTIME="$ROOT/runtimes/${NODE_VERSION}-${NODE_SHA256}"
RELEASE="$ROOT/releases/$RELEASE_ID"
BACKUP="/var/backups/steam-shelf-api/$RELEASE_ID"
DEPLOY_SOURCE=$(cd "$(dirname "$0")" && pwd)
NGINX=/etc/nginx/conf.d/flashcards-api.conf
XRAY=/usr/local/etc/xray/config.json
UNIT=/etc/systemd/system/steam-shelf-gateway.service
RATE=/etc/nginx/conf.d/00-steam-shelf-rate.conf
python3 "$DEPLOY_SOURCE/validate_artifact.py" "$ARTIFACT"

atomic_symlink() {
  local target=$1
  local link=$2
  local temporary_link="${link}.new-$RELEASE_ID"
  rm -f "$temporary_link"
  ln -s "$target" "$temporary_link"
  mv -Tf "$temporary_link" "$link"
}

exec 9>/run/steam-shelf-deploy.lock
flock -n 9 || { echo "another deployment is running" >&2; exit 1; }
[[ ! -e "$ROOT/pending-backup" ]] || { echo "unfinished deployment exists; roll it back first" >&2; exit 1; }
install -d -o root -g root -m 700 "$(dirname "$BACKUP")"
mkdir -m 700 "$BACKUP"

backup_file() {
  local source=$1 name=$2
  if [[ -f "$source" ]]; then cp -a "$source" "$BACKUP/$name"; else touch "$BACKUP/$name.absent"; fi
}
backup_file "$XRAY" xray-config.json
backup_file "$NGINX" nginx-api.conf
backup_file "$UNIT" gateway.service
backup_file "$RATE" nginx-rate.conf
backup_file "$ROOT/active-backup" active-backup
backup_link() {
  local link=$1
  local output=$2
  if [[ -L "$link" ]]; then
    readlink -f "$link" > "$output"
  elif [[ -e "$link" ]]; then
    echo "unsafe non-symlink deployment pointer: $link" >&2
    return 1
  else
    : > "$output"
  fi
}
backup_link "$ROOT/current" "$BACKUP/previous-current"
backup_link "$ROOT/runtime" "$BACKUP/previous-runtime"
service_enabled=$(systemctl is-enabled steam-shelf-gateway.service 2>/dev/null || true)
service_active=$(systemctl is-active steam-shelf-gateway.service 2>/dev/null || true)
if [[ -f "$BACKUP/gateway.service.absent" ]]; then
  [[ "$service_enabled" =~ ^(disabled|not-found)?$ && "$service_active" =~ ^(inactive|unknown)?$ ]]
else
  [[ "$service_enabled" =~ ^(enabled|disabled)$ && "$service_active" =~ ^(active|inactive)$ ]]
fi
[[ "$service_enabled" == enabled ]] || service_enabled=disabled
[[ "$service_active" == active ]] || service_active=inactive
printf '%s\n' "$service_enabled" > "$BACKUP/service-enabled"
printf '%s\n' "$service_active" > "$BACKUP/service-active"
ROOT_STATUS_BEFORE=$(curl --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8443:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.danshin.ms:8443/)
UVICORN_DIRECT_BEFORE=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/docs)
UVICORN_PUBLIC_BEFORE=$(curl --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8443:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.danshin.ms:8443/docs)
printf '%s\n' "$ROOT_STATUS_BEFORE" > "$BACKUP/root-status"
printf '%s\n' "$UVICORN_DIRECT_BEFORE" > "$BACKUP/uvicorn-direct-status"
printf '%s\n' "$UVICORN_PUBLIC_BEFORE" > "$BACKUP/uvicorn-public-status"
printf 'release=%s\nsource_sha=%s\nartifact_sha256=%s\nnode_archive_sha256=%s\nruntime=%s\n' "$RELEASE_ID" "${RELEASE_ID#*-}" "$ARTIFACT_SHA256" "$NODE_SHA256" "$RUNTIME" > "$BACKUP/deployment-manifest"
chmod 600 "$BACKUP"/{previous-current,previous-runtime,service-enabled,service-active,root-status,uvicorn-direct-status,uvicorn-public-status,deployment-manifest}
python3 "$DEPLOY_SOURCE/validate_backup.py" "$BACKUP"
if [[ -s "$BACKUP/previous-runtime" ]]; then
  python3 "$DEPLOY_SOURCE/runtime_integrity.py" verify "$(<"$BACKUP/previous-runtime")" "$ROOT/runtimes"
fi
# The recovery material must reach stable storage before any live pointer or
# boot configuration can change.
sync -f "$BACKUP"

rollback_on_failure() {
  local code=$?
  trap - ERR EXIT
  trap '' INT TERM HUP
  [[ "$code" -ne 0 ]] || code=1
  echo "Deployment failed; rolling back" >&2
  ROLLBACK_FROM_INSTALLER=1 "$DEPLOY_SOURCE/rollback_gateway.sh" "$BACKUP" || echo "AUTOMATIC ROLLBACK FAILED" >&2
  exit "$code"
}
trap rollback_on_failure ERR EXIT INT TERM HUP

check_deployment_avcs() {
  local avc_output avc_code
  if avc_output=$(LC_ALL=C ausearch -m AVC -ts "$DEPLOY_AUDIT_DATE" "$DEPLOY_AUDIT_TIME" 2>&1); then
    python3 -c 'import sys; raise SystemExit(1 if "avc:  denied" in sys.stdin.read().lower() else 0)' <<<"$avc_output"
  else
    avc_code=$?
    [[ "$avc_code" == 1 && "$avc_output" == *"<no matches>"* ]]
  fi
}

getent group steam-shelf >/dev/null || groupadd --system steam-shelf
id steam-shelf >/dev/null 2>&1 || useradd --system --gid steam-shelf --home-dir /nonexistent --shell /sbin/nologin steam-shelf
[[ $(id -u steam-shelf) -ne 0 && $(id -gn steam-shelf) == steam-shelf ]]
install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"

# Publish and durably flush recovery intent before the first live runtime or
# service mutation. A crash leaves this pointer for the documented retry path.
pending_tmp=$(mktemp "$ROOT/.pending-backup.XXXXXX")
printf '%s\n' "$BACKUP" > "$pending_tmp"
chown root:root "$pending_tmp"; chmod 600 "$pending_tmp"; mv -fT "$pending_tmp" "$ROOT/pending-backup"
sync -f "$ROOT"

if [[ ! -x "$RUNTIME/bin/node" ]]; then
  install -d -o root -g root -m 755 "$ROOT/runtimes"
  temporary=$(mktemp -d)
  curl -fsS --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE" -o "$temporary/$NODE_ARCHIVE"
  (cd "$temporary" && printf '%s  %s\n' "$NODE_SHA256" "$NODE_ARCHIVE" | sha256sum -c -)
  tar -xJf "$temporary/$NODE_ARCHIVE" --no-same-owner -C "$temporary"
  extracted="$temporary/node-$NODE_VERSION-linux-x64"
  python3 "$DEPLOY_SOURCE/runtime_integrity.py" create "$extracted"
  mv "$extracted" "$RUNTIME"
  rm -rf "$temporary"
fi
chown -R root:root "$RUNTIME"
chmod -R u=rwX,go=rX "$RUNTIME"
restorecon -RF "$RUNTIME"
[[ -f "$RUNTIME/.steam-shelf-integrity.json" && -x "$RUNTIME/bin/node" && -f "$RUNTIME/bin/npm" ]]
python3 "$DEPLOY_SOURCE/runtime_integrity.py" verify "$RUNTIME" "$ROOT/runtimes"
# Runtime contents must be durable before publishing the boot-visible symlink.
sync
atomic_symlink "$RUNTIME" "$ROOT/runtime"
sync -f "$ROOT"
[[ $("$ROOT/runtime/bin/node" --version) == "$NODE_VERSION" ]]

[[ ! -e "$RELEASE" ]] || { echo "release already exists" >&2; exit 1; }
install -d -o root -g root -m 755 "$RELEASE"
tar -xzf "$ARTIFACT" --no-same-owner -C "$RELEASE"
[[ -f "$RELEASE/gateway/server.js" && -f "$RELEASE/functions/steam-sync.js" && -f "$RELEASE/gateway/package-lock.json" ]] || { echo "incomplete artifact" >&2; exit 1; }
PATH="$ROOT/runtime/bin:$PATH" "$ROOT/runtime/bin/npm" --prefix "$RELEASE/gateway" ci --omit=dev --ignore-scripts
chown -R root:root "$RELEASE"
chmod -R u=rwX,go=rX "$RELEASE"
restorecon -RF "$RELEASE"
# Release contents must be durable before `current` can reference them.
sync

ensure_http_port() {
  local port=$1
  local classification
  classification=$(python3 "$DEPLOY_SOURCE/selinux_port.py" classify "$port")
  [[ "$classification" == add || "$classification" == ready ]]
  [[ "$classification" == add ]] || return 0
  # Persist intent before mutation, but grant rollback deletion authority only
  # after semanage itself succeeds. A crash in between fails closed in validation.
  local intent_marker="$BACKUP/adding-http-port-$port"
  local owned_marker="$BACKUP/added-http-port-$port"
  touch "$intent_marker"
  sync -f "$BACKUP"
  if ! semanage port -a -t http_port_t -p tcp "$port"; then
    rm -f "$intent_marker"
    sync -f "$BACKUP"
    return 1
  fi
  mv -fT "$intent_marker" "$owned_marker"
  sync -f "$BACKUP"
  python3 "$DEPLOY_SOURCE/selinux_port.py" verify-owned "$port" >/dev/null
}
ensure_http_port 8001
ensure_http_port 8444
# Persist SELinux policy before any boot configuration can depend on it.
sync

# Persist required SELinux labels before writing boot-visible nginx/Xray config.
install -o root -g root -m 644 "$DEPLOY_SOURCE/steam-shelf-gateway.service" "$UNIT"
install -o root -g root -m 644 "$DEPLOY_SOURCE/nginx-rate-zone.conf" "$RATE"
python3 "$DEPLOY_SOURCE/configure_nginx.py" "$NGINX" "$DEPLOY_SOURCE/nginx-location.conf" "$DEPLOY_SOURCE/nginx-proxy-protocol.conf"
# The 8444 nginx listener must be durable before Xray can durably target it.
sync
python3 "$DEPLOY_SOURCE/configure_xray.py" "$XRAY"
sync

atomic_symlink "$RELEASE" "$ROOT/current"
# A boot-enabled existing unit must never observe a current link whose release
# contents are not durable.
sync -f "$ROOT"
systemctl daemon-reload
systemd-analyze verify "$UNIT"
nginx -t
/usr/local/bin/xray run -test -config "$XRAY"
systemctl enable steam-shelf-gateway.service
systemctl restart steam-shelf-gateway.service
# Type=simple becomes active before the child necessarily completes chdir/exec.
# Wait until one observation proves the active PID, immutable cwd and HTTP
# readiness together instead of racing the pre-exec child state.
gateway_ready=0
for _ in {1..50}; do
  if systemctl is-active --quiet steam-shelf-gateway.service; then
    gateway_pid=$(systemctl show steam-shelf-gateway.service -p MainPID --value)
    if [[ "$gateway_pid" =~ ^[1-9][0-9]*$ ]] &&
       [[ $(readlink -f "/proc/$gateway_pid/cwd") == "$RELEASE/gateway" ]] &&
       status=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' -X OPTIONS http://127.0.0.1:8001/steam-shelf/v1/sync -H 'Origin: https://danshin.ms' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type') &&
       [[ "$status" == 204 ]]; then
      gateway_ready=1
      break
    fi
  fi
  sleep 0.2
done
[[ "$gateway_ready" == 1 ]]

# Validate the isolated service before changing nginx or Xray.
[[ $(stat -c '%U:%G:%a' /var/lib/steam-shelf-gateway) == steam-shelf:steam-shelf:700 ]]
[[ -z $(find /var/lib/steam-shelf-gateway \( ! -user steam-shelf -o ! -group steam-shelf -o -type f -perm /077 \) -print -quit) ]]

# Nginx starts a second PROXY-protocol listener; the old 8443 listener remains available for rollback.
systemctl reload nginx
# This request traverses nginx -> 127.0.0.1:8001 before Xray is changed. Under
# SELinux Enforcing it is the fail-closed proof that the precise proxy path is allowed.
[[ $(getenforce) == Enforcing ]]
selinux_proxy_ready=0
selinux_proxy_deadline=$((SECONDS + 120))
while (( SECONDS < selinux_proxy_deadline )); do
  if selinux_proxy_status=$(curl -sS --max-time 2 --resolve api.danshin.ms:8443:127.0.0.1 -o /dev/null -w '%{http_code}' -X OPTIONS https://api.danshin.ms:8443/steam-shelf/v1/sync -H 'Origin: https://danshin.ms' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type') &&
     [[ "$selinux_proxy_status" == 204 ]] &&
     (( SECONDS < selinux_proxy_deadline )); then
    selinux_proxy_ready=1
    break
  fi
  (( SECONDS < selinux_proxy_deadline )) || break
  sleep 0.5
done
[[ "$selinux_proxy_ready" == 1 ]]
systemctl restart xray
sleep 1

fallback_options=$(curl --haproxy-protocol --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8444:127.0.0.1 -o /dev/null -w '%{http_code}' -X OPTIONS https://api.danshin.ms:8444/steam-shelf/v1/sync -H 'Origin: https://danshin.ms' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type')
fallback_auth=$(curl --haproxy-protocol --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8444:127.0.0.1 -o /dev/null -w '%{http_code}' -X POST https://api.danshin.ms:8444/steam-shelf/v1/sync -H 'Origin: https://danshin.ms' -H 'Content-Type: application/json' --data '{}')
[[ "$fallback_options" == 204 && "$fallback_auth" == 401 ]]
root_status_after=$(curl --haproxy-protocol --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8444:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.danshin.ms:8444/)
[[ "$root_status_after" == "$ROOT_STATUS_BEFORE" ]]
uvicorn_direct_after=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/docs)
uvicorn_fallback_after=$(curl --haproxy-protocol --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8444:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.danshin.ms:8444/docs)
[[ "$uvicorn_direct_after" == "$UVICORN_DIRECT_BEFORE" && "$uvicorn_fallback_after" == "$UVICORN_PUBLIC_BEFORE" ]]
systemctl is-active --quiet steam-shelf-gateway.service nginx xray
ss -ltn | python3 -c 'import sys
lines=sys.stdin.read().splitlines()
required={"127.0.0.1:8001", "127.0.0.1:8444"}
listeners={line.split()[3] for line in lines[1:] if len(line.split()) >= 4}
raise SystemExit(0 if required <= listeners and not any(value.endswith(":8001") and value != "127.0.0.1:8001" for value in listeners) else 1)'
firewall-cmd --list-ports | python3 -c 'import sys; ports=set(sys.stdin.read().split()); raise SystemExit(1 if {"8001/tcp", "8444/tcp"} & ports else 0)'
[[ $(getenforce) == Enforcing ]]
[[ $(getsebool httpd_can_network_connect) == *" --> off" ]]
check_deployment_avcs

# Exercise the live nginx limiter through the PROXY-protocol fallback without relying
# on this host reaching its own public address. At least one response must be a CORS-safe 429.
rate_limited=0
for _ in {1..45}; do
  headers=$(mktemp)
  code=$(curl --haproxy-protocol --noproxy '*' -sS --max-time 10 --resolve api.danshin.ms:8444:127.0.0.1 -D "$headers" -o /dev/null -w '%{http_code}' -X OPTIONS https://api.danshin.ms:8444/steam-shelf/v1/sync -H 'Origin: https://danshin.ms' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type')
  if [[ "$code" == 429 ]]; then
    python3 -c 'import pathlib,sys; text=pathlib.Path(sys.argv[1]).read_text(errors="replace").lower(); raise SystemExit(0 if "access-control-allow-origin: https://danshin.ms" in text else 1)' "$headers"
    rate_limited=1
  fi
  rm -f "$headers"
done
[[ "$rate_limited" == 1 ]]

# The release remains inside automatic rollback until a second administrator session
# verifies public route 204/401, root/docs preservation and a non-loopback PROXY marker,
# and the operator verifies the existing coexisting proxy connection is unaffected.
VPN_CONFIRMATION="/run/steam-shelf-vpn-confirmed-$RELEASE_ID"
rm -f "$VPN_CONFIRMATION"
echo "Waiting up to 10 minutes for manual connectivity verification: $VPN_CONFIRMATION"
for _ in {1..120}; do
  [[ -f "$VPN_CONFIRMATION" ]] && break
  sleep 5
done
[[ -f "$VPN_CONFIRMATION" && $(<"$VPN_CONFIRMATION") == "$RELEASE_ID" ]]
rm -f "$VPN_CONFIRMATION"
python3 -c 'import ipaddress,pathlib,sys
lines=pathlib.Path("/var/log/nginx/access.log").read_text(errors="replace").splitlines()[-200:]
marker="steam-shelf-deploy/" + sys.argv[1]
matches=[line for line in lines if "/steam-shelf/v1/sync" in line and marker in line]
if not matches: raise SystemExit("PROXY protocol did not preserve the client address")
try: source=ipaddress.ip_address(matches[-1].split()[0])
except (ValueError,IndexError): raise SystemExit("PROXY protocol did not preserve the client address")
ipv4_loopback=ipaddress.ip_network("127.0.0.0/8")
mapped=getattr(source,"ipv4_mapped",None)
if source == ipaddress.ip_address("::1") or (source.version == 4 and source in ipv4_loopback) or (mapped is not None and mapped in ipv4_loopback): raise SystemExit("PROXY protocol did not preserve the client address")' "$RELEASE_ID"
check_deployment_avcs
# Flush all restored/new service state before publishing a durable success pointer.
sync
active_backup_tmp=$(mktemp "$ROOT/.active-backup.XXXXXX")
printf '%s\n' "$BACKUP" > "$active_backup_tmp"
chown root:root "$active_backup_tmp"; chmod 600 "$active_backup_tmp"; mv -fT "$active_backup_tmp" "$ROOT/active-backup"
sync -f "$ROOT"
rm -f "$ROOT/pending-backup"
sync -f "$ROOT"
trap - ERR EXIT INT TERM HUP
echo "Gateway release $RELEASE_ID activated; rollback backup: $BACKUP"
