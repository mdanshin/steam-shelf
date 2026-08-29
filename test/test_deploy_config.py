import json
import io
import importlib.util
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]


class DeployConfigTests(unittest.TestCase):
    def test_selinux_port_classification_is_exact_and_fail_closed(self):
        spec = importlib.util.spec_from_file_location("selinux_port", ROOT / "deploy/selinux_port.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        unreserved = "unreserved_port_t tcp 1024-32767\n"
        self.assertEqual(module.classify(unreserved, "", 8001), "add")
        self.assertEqual(module.classify(unreserved + "http_port_t tcp 8001\n", "http_port_t tcp 8001\n", 8001), "ready")
        with self.assertRaises(ValueError):
            module.classify(unreserved + "z_custom_port_t tcp 8001\n", "z_custom_port_t tcp 8001\n", 8001)
        with self.assertRaises(ValueError):
            module.classify(unreserved + "http_port_t tcp 8000-9000\n", "http_port_t tcp 8000-9000\n", 8001)
        self.assertEqual(module.ownership("http_port_t tcp 8001\n", 8001), "owned")
        self.assertEqual(module.ownership("", 8001), "absent")
        failed = subprocess.CompletedProcess([], 2, stdout="", stderr="listing denied")
        with mock.patch.object(module.subprocess, "run", return_value=failed):
            with self.assertRaises(RuntimeError):
                module.listing()

    def test_backup_validator_rejects_missing_and_conflicting_markers_before_rollback(self):
        validator_source = (ROOT / "deploy/validate_backup.py").read_text(encoding="utf-8")
        self.assertNotIn("item.st_uid", validator_source)
        self.assertNotIn("item.st_gid", validator_source)
        spec = importlib.util.spec_from_file_location("validate_backup", ROOT / "deploy/validate_backup.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            root = base / "root"; (root / "releases").mkdir(parents=True); (root / "runtimes").mkdir()
            backup_root = base / "backups"; backup_root.mkdir()
            release = "20260823T120000Z-0123456789ab"
            backup = backup_root / release; backup.mkdir(mode=0o700); backup.chmod(0o700)
            values = {
                "previous-current": "", "previous-runtime": "", "service-enabled": "disabled", "service-active": "inactive",
                "root-status": "200", "uvicorn-direct-status": "200", "uvicorn-public-status": "200",
                "deployment-manifest": f"release={release}\nartifact_sha256={'a' * 64}\n",
            }
            for name, value in values.items():
                path = backup / name; path.write_text(value + ("" if value.endswith("\n") else "\n"), encoding="utf-8"); path.chmod(0o600)
            for name in module.CONFIGS:
                path = backup / f"{name}.absent"; path.touch(); path.chmod(0o600)
            self.assertEqual(module.validate_backup(backup, root, backup_root, enforce_metadata=False), backup.resolve())
            (backup / "service-active").unlink()
            with self.assertRaises(ValueError): module.validate_backup(backup, root, backup_root, enforce_metadata=False)
            path = backup / "service-active"; path.write_text("inactive\n", encoding="utf-8"); path.chmod(0o600)
            path = backup / "xray-config.json"; path.write_text("{}", encoding="utf-8"); path.chmod(0o600)
            with self.assertRaises(ValueError): module.validate_backup(backup, root, backup_root, enforce_metadata=False)

    def test_gateway_artifact_validator_rejects_links_and_unexpected_files(self):
        validator = str(ROOT / "deploy/validate_artifact.py")
        required = {
            "gateway/package.json": b"{}",
            "gateway/package-lock.json": b"{}",
            "gateway/server.js": b"export {};",
            "functions/steam-sync.js": b"export {};",
        }
        with tempfile.TemporaryDirectory() as directory:
            safe = pathlib.Path(directory) / "safe.tar.gz"
            with tarfile.open(safe, "w:gz") as archive:
                for name, content in required.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            subprocess.run([sys.executable, validator, str(safe)], check=True)

            unsafe = pathlib.Path(directory) / "unsafe.tar.gz"
            with tarfile.open(unsafe, "w:gz") as archive:
                for name, content in required.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
                link = tarfile.TarInfo("gateway/escape")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside"
                archive.addfile(link)
            result = subprocess.run([sys.executable, validator, str(unsafe)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_all_gateway_methods_share_the_real_client_ip_limiter(self):
        rate = (ROOT / "deploy/nginx-rate-zone.conf").read_text(encoding="utf-8")
        self.assertIn("limit_req_zone $binary_remote_addr", rate)
        self.assertNotIn("OPTIONS", rate)

    def test_install_and_rollback_preserve_runtime_and_config_ownership(self):
        install = (ROOT / "deploy/install_gateway.sh").read_text(encoding="utf-8")
        rollback = (ROOT / "deploy/rollback_gateway.sh").read_text(encoding="utf-8")
        self.assertNotIn('local target=$1 link=$2 temporary_link=', install)
        self.assertNotIn('local saved=$1 link=$2 temporary_link=', rollback)
        self.assertIn('backup_link "$ROOT/current" "$BACKUP/previous-current"', install)
        self.assertIn('elif [[ -e "$link" ]]', install)
        self.assertNotIn('readlink -f "$ROOT/current" > "$BACKUP/previous-current"', install)
        self.assertLess(install.index('command -v "$dependency"'), install.index('mkdir -m 700 "$BACKUP"'))
        for dependency in ("find", "restorecon", "sleep", "stat", "systemd-analyze", "tar", "useradd"):
            self.assertIn(dependency, install)
        self.assertIn("[[ -x /usr/local/bin/xray ]]", install)
        self.assertIn('tar -xJf "$temporary/$NODE_ARCHIVE" --no-same-owner', install)
        self.assertIn('chown -R root:root "$RUNTIME"', install)
        self.assertLess(install.index('restorecon -RF "$RUNTIME"'), install.index('runtime_integrity.py" verify "$RUNTIME"'))
        self.assertLess(install.index('restorecon -RF "$RELEASE"'), install.index('# Release contents must be durable'))
        self.assertIn('runtime_integrity.py" verify "$RUNTIME"', install)
        self.assertIn('== "$NODE_VERSION"', install)
        self.assertNotIn('== "v$NODE_VERSION"', install)
        self.assertIn('PATH="$ROOT/runtime/bin:$PATH" "$ROOT/runtime/bin/npm"', install)
        self.assertIn('backup_link "$ROOT/runtime" "$BACKUP/previous-runtime"', install)
        self.assertIn('systemctl restart steam-shelf-gateway.service', install)
        self.assertIn('readlink -f "/proc/$gateway_pid/cwd"', install)
        readiness = install[install.index('gateway_ready=0'):install.index('[[ $(stat -c')]
        self.assertIn('for _ in {1..50}; do', readiness)
        self.assertIn('systemctl is-active --quiet steam-shelf-gateway.service', readiness)
        self.assertIn('systemctl show steam-shelf-gateway.service -p MainPID --value', readiness)
        self.assertIn('[[ "$status" == 204 ]]', readiness)
        self.assertIn('sleep 0.2', readiness)
        self.assertIn('[[ "$gateway_ready" == 1 ]]', readiness)
        self.assertLess(install.index('systemctl restart steam-shelf-gateway.service'), install.index('gateway_ready=0'))
        self.assertIn('rate_limited=0', install)
        self.assertIn('trap rollback_on_failure ERR EXIT INT TERM HUP', install)
        self.assertLess(install.index('touch "$intent_marker"'), install.index('semanage port -a -t http_port_t -p tcp "$port"'))
        self.assertLess(install.index('semanage port -a -t http_port_t -p tcp "$port"'), install.index('mv -fT "$intent_marker" "$owned_marker"'))
        self.assertIn('selinux_port.py" verify-owned "$port"', install)
        self.assertLess(install.index('mv -fT "$pending_tmp" "$ROOT/pending-backup"'), install.index('install -o root -g root -m 644 "$DEPLOY_SOURCE/steam-shelf-gateway.service"'))
        self.assertLess(install.index('mv -fT "$pending_tmp" "$ROOT/pending-backup"'), install.index('atomic_symlink "$RUNTIME" "$ROOT/runtime"'))
        self.assertLess(install.index('sync -f "$BACKUP"'), install.index('mv -fT "$pending_tmp" "$ROOT/pending-backup"'))
        self.assertLess(install.index('ensure_http_port 8444'), install.index('configure_xray.py'))
        self.assertIn('selinux_port.py" classify "$port"', install)
        nginx_write = install.index('configure_nginx.py')
        xray_write = install.index('configure_xray.py')
        self.assertLess(nginx_write, xray_write)
        self.assertIn('\nsync\n', install[nginx_write:xray_write])
        self.assertIn('\nsync\n', install[install.index('ensure_http_port 8444'):nginx_write])
        current_publish = install.index('atomic_symlink "$RELEASE" "$ROOT/current"')
        service_enable = install.index('systemctl enable steam-shelf-gateway.service')
        self.assertIn('sync -f "$ROOT"', install[current_publish:service_enable])
        self.assertIn('unfinished deployment exists; roll it back first', install)
        self.assertIn('--resolve api.danshin.ms:8443:127.0.0.1', install)
        proxy_readiness = install[install.index('selinux_proxy_ready=0'):install.index('systemctl restart xray')]
        self.assertIn('selinux_proxy_deadline=$((SECONDS + 120))', proxy_readiness)
        self.assertIn('while (( SECONDS < selinux_proxy_deadline )); do', proxy_readiness)
        self.assertIn('[[ "$selinux_proxy_status" == 204 ]]', proxy_readiness)
        self.assertGreaterEqual(proxy_readiness.count('(( SECONDS < selinux_proxy_deadline ))'), 2)
        self.assertIn('(( SECONDS < selinux_proxy_deadline )) || break', proxy_readiness)
        self.assertIn('sleep 0.5', proxy_readiness)
        self.assertIn('[[ "$selinux_proxy_ready" == 1 ]]', proxy_readiness)
        self.assertNotIn('ausearch -m AVC -ts "$DEPLOY_AUDIT_START" 2>/dev/null || true', install)
        self.assertIn("read -r DEPLOY_AUDIT_DATE DEPLOY_AUDIT_TIME <<<\"$(LC_ALL=C date '+%x %T')\"", install)
        self.assertIn('ausearch -m AVC -ts "$DEPLOY_AUDIT_DATE" "$DEPLOY_AUDIT_TIME"', install)
        self.assertIn('cp -a --remove-destination "$BACKUP/$name" "$target"', rollback)
        self.assertIn('restore_link "$BACKUP/previous-runtime"', rollback)
        self.assertIn('previous_enabled=$(<"$BACKUP/service-enabled")', rollback)
        self.assertIn('$(<"$BACKUP/uvicorn-direct-status")', rollback)
        self.assertGreaterEqual(install.count("--noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8443:127.0.0.1"), 2)
        self.assertGreaterEqual(rollback.count("--noproxy '*' -sS --max-time 15 --resolve api.danshin.ms:8443:127.0.0.1"), 2)
        self.assertNotIn("-w '%{http_code}' https://api.danshin.ms/docs) ==", rollback)
        self.assertGreaterEqual(install.count("--haproxy-protocol --noproxy '*'"), 5)
        self.assertNotIn('public_options=$(curl', install)
        self.assertLess(install.index('[[ -f "$VPN_CONFIRMATION"'), install.index('PROXY protocol did not preserve the client address'))
        self.assertIn('source=ipaddress.ip_address(matches[-1].split()[0])', install)
        self.assertIn('ipv4_loopback=ipaddress.ip_network("127.0.0.0/8")', install)
        self.assertIn('mapped=getattr(source,"ipv4_mapped",None)', install)
        self.assertIn('mapped is not None and mapped in ipv4_loopback', install)
        self.assertNotIn('if source.is_loopback:', install)
        self.assertNotIn('matches[-1].split()[0] in {"127.0.0.1", "::1"}', install)
        ipaddress = __import__("ipaddress")
        ipv4_loopback = ipaddress.ip_network("127.0.0.0/8")
        for value in ("127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "::ffff:127.0.0.2"):
            source = ipaddress.ip_address(value)
            mapped = getattr(source, "ipv4_mapped", None)
            self.assertTrue(source == ipaddress.ip_address("::1") or (source.version == 4 and source in ipv4_loopback) or (mapped is not None and mapped in ipv4_loopback))
        self.assertIn('validate_backup.py" "$BACKUP"', rollback)
        self.assertLess(rollback.index('systemctl restart xray'), rollback.index('systemctl reload nginx'))
        self.assertIn('\nsync\n', rollback[rollback.index('restore_file xray-config.json'):rollback.index('systemctl restart xray')])
        self.assertIn('\nsync\n', rollback[rollback.index('restore_file nginx-api.conf'):rollback.index('systemctl reload nginx')])
        self.assertLess(rollback.index('systemctl reload nginx'), rollback.index('remove_added_http_port 8444'))
        self.assertIn('selinux_port.py" ownership "$port"', rollback)
        self.assertIn('semanage port -d -p tcp "$port"', rollback)
        self.assertGreater(rollback.index('if [[ -f "$BACKUP/active-backup" ]]'), rollback.index('[[ "$actual_active" == "$previous_active" ]]'))
        self.assertGreater(rollback.index('rm -f "$ROOT/pending-backup"'), rollback.index('[[ "$actual_active" == "$previous_active" ]]'))
        self.assertGreaterEqual(install.count('sync -f "$ROOT"'), 3)
        self.assertGreaterEqual(rollback.count('sync -f "$ROOT"'), 2)

    def test_runtime_integrity_allows_internal_symlinks_and_rejects_extra_entries(self):
        if getattr(os, "geteuid", lambda: -1)() != 0:
            self.skipTest("runtime ownership verification requires root")
        helper = ROOT / "deploy/runtime_integrity.py"
        with tempfile.TemporaryDirectory() as directory:
            runtime_root = pathlib.Path(directory) / "runtimes"
            runtime = runtime_root / "v24.19.0-digest"
            (runtime / "bin").mkdir(parents=True)
            (runtime / "bin/node").write_bytes(b"pinned node")
            try:
                (runtime / "bin/npm").symlink_to("node")
            except OSError:
                self.skipTest("symlink creation is unavailable")
            subprocess.run([sys.executable, helper, "create", runtime], check=True)
            for path in [runtime, *runtime.rglob("*")]:
                if not path.is_symlink():
                    path.chmod(0o755 if path.is_dir() else 0o644)
            subprocess.run([sys.executable, helper, "verify", runtime, runtime_root], check=True)
            (runtime / "unexpected").write_text("tamper", encoding="utf-8")
            result = subprocess.run([sys.executable, helper, "verify", runtime, runtime_root], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_nginx_configuration_is_scoped_and_idempotent(self):
        original = """server {
    server_name unrelated.example;
    location / {
        return 204;
    }
    listen 127.0.0.1:8443 ssl; # managed by Certbot
}
server {
    server_name api.danshin.ms;
    location / {
        proxy_pass http://127.0.0.1:8000;
    }
    listen 127.0.0.1:8443 ssl; # managed by Certbot
}
server {
    listen 80;
    server_name api.danshin.ms;
    return 301 https://$host$request_uri;
}
"""
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "api.conf"
            config.write_text(original, encoding="utf-8")
            command = [sys.executable, str(ROOT / "deploy/configure_nginx.py"), str(config), str(ROOT / "deploy/nginx-location.conf"), str(ROOT / "deploy/nginx-proxy-protocol.conf")]
            subprocess.run(command, check=True)
            once = config.read_text(encoding="utf-8")
            subprocess.run(command, check=True)
            self.assertEqual(config.read_text(encoding="utf-8"), once)
            self.assertIn("location = /steam-shelf/v1/sync", once)
            self.assertIn("listen 127.0.0.1:8444 ssl proxy_protocol", once)
            self.assertIn("proxy_pass http://127.0.0.1:8000", once)
            unrelated = once.split("server {", 2)[1]
            self.assertNotIn("STEAM SHELF", unrelated)
            redirect = once[once.index("    listen 80;"):]
            self.assertNotIn("STEAM SHELF", redirect)

    def test_xray_configuration_changes_only_fallback_transport(self):
        source = {
            "inbounds": [{
                "port": 443,
                "protocol": "vless",
                "settings": {"clients": [{"id": "keep-private-value"}]},
                "streamSettings": {"realitySettings": {"dest": "127.0.0.1:8443", "xver": 0, "privateKey": "keep-private-key"}},
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.json"
            config.write_text(json.dumps(source), encoding="utf-8")
            command = [sys.executable, str(ROOT / "deploy/configure_xray.py"), str(config)]
            subprocess.run(command, check=True)
            subprocess.run(command, check=True)
            result = json.loads(config.read_text(encoding="utf-8"))
            inbound = result["inbounds"][0]
            self.assertEqual(inbound["settings"], source["inbounds"][0]["settings"])
            self.assertEqual(inbound["streamSettings"]["realitySettings"]["privateKey"], "keep-private-key")
            self.assertEqual(inbound["streamSettings"]["realitySettings"]["dest"], "127.0.0.1:8444")
            self.assertEqual(inbound["streamSettings"]["realitySettings"]["xver"], 1)


if __name__ == "__main__":
    unittest.main()
