#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${EUID} -ne 0 || $# -ne 1 ]]; then
  echo "usage: sudo rollback_gateway.sh BACKUP_DIRECTORY" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKUP=$1
python3 "$SCRIPT_DIR/validate_backup.py" "$BACKUP"
BACKUP=$(readlink -f "$BACKUP")
if [[ ${ROLLBACK_FROM_INSTALLER:-0} != 1 ]]; then
  exec 8>/run/steam-shelf-deploy.lock
  flock -n 8 || { echo "deployment is active; rollback refused" >&2; exit 1; }
fi
NGINX=/etc/nginx/conf.d/flashcards-api.conf
XRAY=/usr/local/etc/xray/config.json
UNIT=/etc/systemd/system/steam-shelf-gateway.service
RATE=/etc/nginx/conf.d/00-steam-shelf-rate.conf
ROOT=/opt/steam-shelf-api

if [[ -s "$BACKUP/previous-runtime" ]]; then
  python3 "$SCRIPT_DIR/runtime_integrity.py" verify "$(<"$BACKUP/previous-runtime")" "$ROOT/runtimes"
fi

restore_file() {
  local name=$1 target=$2
  if [[ -f "$BACKUP/$name" ]]; then
    cp -a --remove-destination "$BACKUP/$name" "$target"
  elif [[ -f "$BACKUP/$name.absent" ]]; then
    rm -f "$target"
  else
    echo "missing rollback marker for $target" >&2
    exit 1
  fi
}

# On first-install rollback, remove the enablement symlink while the deployed unit
# still exists; removing the unit first can leave a dangling wants/ symlink.
if [[ -f "$BACKUP/gateway.service.absent" ]]; then
  if [[ -f "$UNIT" ]]; then systemctl disable --now steam-shelf-gateway.service; fi
  rm -f /etc/systemd/system/multi-user.target.wants/steam-shelf-gateway.service
fi
restore_file xray-config.json "$XRAY"
# Make the old 8443 target durable and move running Xray back while nginx still
# exposes both listeners. A crash at either side of this barrier remains boot-safe.
/usr/local/bin/xray run -test -config "$XRAY"
sync
systemctl restart xray

restore_file nginx-api.conf "$NGINX"
restore_file nginx-rate.conf "$RATE"
nginx -t
# Only after Xray is durably back on 8443 may nginx durably remove 8444.
sync
systemctl reload nginx

restore_file gateway.service "$UNIT"

restore_link() {
  local saved=$1
  local link=$2
  local temporary_link="${link}.rollback-$$"
  if [[ -s "$saved" ]]; then
    local target
    target=$(<"$saved")
    [[ -e "$target" ]]
    rm -f "$temporary_link"
    ln -s "$target" "$temporary_link"
    mv -Tf "$temporary_link" "$link"
    [[ $(readlink -f "$link") == "$target" ]]
  else
    rm -f "$link"
  fi
}
restore_link "$BACKUP/previous-current" "$ROOT/current"
restore_link "$BACKUP/previous-runtime" "$ROOT/runtime"
# Persist old unit/runtime/release dependencies before restoring service state.
sync

remove_added_http_port() {
  local port=$1
  local ownership
  if [[ -f "$BACKUP/added-http-port-$port" ]]; then
    ownership=$(python3 "$SCRIPT_DIR/selinux_port.py" ownership "$port")
    [[ "$ownership" == owned || "$ownership" == absent ]]
    if [[ "$ownership" == owned ]]; then
      semanage port -d -p tcp "$port"
      [[ $(python3 "$SCRIPT_DIR/selinux_port.py" ownership "$port") == absent ]]
    fi
  fi
}
systemctl daemon-reload
previous_enabled=$(<"$BACKUP/service-enabled")
previous_active=$(<"$BACKUP/service-active")
if [[ "$previous_enabled" == enabled ]]; then
  systemctl enable steam-shelf-gateway.service
else
  if [[ -f "$UNIT" ]]; then systemctl disable steam-shelf-gateway.service; fi
fi
if [[ "$previous_active" == active ]]; then
  systemctl restart steam-shelf-gateway.service
  gateway_pid=$(systemctl show steam-shelf-gateway.service -p MainPID --value)
  [[ "$gateway_pid" =~ ^[1-9][0-9]*$ ]]
  previous_current=$(<"$BACKUP/previous-current")
  [[ $(readlink -f "/proc/$gateway_pid/cwd") == "$previous_current/gateway" ]]
else
  systemctl stop steam-shelf-gateway.service 2>/dev/null || [[ ! -f "$UNIT" ]]
fi

# Restored boot configuration and service state are durable before removing the
# temporary SELinux labels they no longer require.
sync
remove_added_http_port 8001
remove_added_http_port 8444
sync
systemctl is-active --quiet nginx xray
[[ $(curl --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8443:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.danshin.ms:8443/) == $(<"$BACKUP/root-status") ]]
[[ $(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/docs) == $(<"$BACKUP/uvicorn-direct-status") ]]
[[ $(curl --noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8443:127.0.0.1 -o /dev/null -w '%{http_code}' https://api.danshin.ms:8443/docs) == $(<"$BACKUP/uvicorn-public-status") ]]
if actual_enabled=$(systemctl is-enabled steam-shelf-gateway.service 2>/dev/null); then :; else actual_enabled=disabled; fi
if actual_active=$(systemctl is-active steam-shelf-gateway.service 2>/dev/null); then :; else actual_active=inactive; fi
[[ "$actual_enabled" == "$previous_enabled" ]]
[[ "$actual_active" == "$previous_active" ]]

# Make restored configs, links, SELinux state and service metadata durable before
# changing recovery pointers.
sync

# Keep the currently authoritative pointer intact until every rollback action and
# verification has passed. Publish the prior pointer atomically only at success.
if [[ -f "$BACKUP/active-backup" ]]; then
  active_tmp=$(mktemp "$ROOT/.active-backup.rollback.XXXXXX")
  rm -f "$active_tmp"; cp -a "$BACKUP/active-backup" "$active_tmp"
  mv -fT "$active_tmp" "$ROOT/active-backup"
else
  rm -f "$ROOT/active-backup"
fi
sync -f "$ROOT"
rm -f "$ROOT/pending-backup"
sync -f "$ROOT"
echo "Rollback completed from $BACKUP"
