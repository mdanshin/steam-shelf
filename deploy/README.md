# Steam Shelf gateway deployment

The gateway is stateless except for hashed per-UID quota counters in `/var/lib/steam-shelf-gateway/limits.sqlite`. Steam credentials and catalog snapshots are never stored on the VPS.

## Preconditions

- Exact release candidate passed `npm test`, `npm run check`, both npm audits, and independent review.
- Artifact contains only `gateway/` and `functions/steam-sync.js`; verify its SHA-256 before upload.
- Target is CentOS 9 x86_64 with SELinux enforcing, an existing TLS listener on `:443`, nginx fallback on loopback `:8443`, and an existing uvicorn service on `:8000`.
- `deploy/install_gateway.sh` pins Node `v24.19.0` and the official linux-x64 archive SHA-256.

## Deploy

Upload the artifact and the complete `deploy/` directory to a root-only staging directory. Then run:

```bash
# RELEASE_ID is UTC timestamp plus the first 12 characters of the reviewed source SHA.
sudo chmod 700 /root/steam-shelf-deploy/install_gateway.sh /root/steam-shelf-deploy/rollback_gateway.sh
sudo /root/steam-shelf-deploy/install_gateway.sh 20260822T120000Z-0123456789ab /root/steam-shelf-release.tar.gz EXPECTED_ARTIFACT_SHA256
```

The installer:

1. Takes a deployment lock; creates and validates a new root-only backup of nginx, Xray, systemd, SELinux-port state, active-backup metadata, and both previous atomic symlinks before any production mutation.
2. Installs checksum-pinned Node into a digest-addressed runtime directory and verifies its root ownership, non-writability by the service, and complete file-integrity manifest on every deployment.
3. Runs `npm ci --omit=dev --ignore-scripts` from the gateway lockfile.
4. Creates an immutable release and atomically switches `/opt/steam-shelf-api/current`.
5. labels loopback ports `8001` and `8444` as `http_port_t` without enabling the broad `httpd_can_network_connect` boolean.
6. Keeps nginx `8443` as the old non-PROXY listener, adds `8444` with PROXY protocol, then switches Xray to `8444`/`xver: 1` only after the gateway and nginx validate.
7. Checks systemd, the running release path, nginx, Xray, direct/public CORS, unauthenticated rejection, real client-IP preservation, existing uvicorn routes, SELinux state, and AVCs through the end of the rollback-armed deployment window.
8. Keeps automatic rollback armed, including for interruption signals, for ten minutes while the operator reconnects through the existing coexisting proxy client and confirms external connectivity through it. Only after that real check, a second administrator session confirms the displayed release ID:

   ```bash
   # Replace RELEASE_ID with the exact value printed by the waiting installer.
   printf '%s\n' 'RELEASE_ID' | sudo tee '/run/steam-shelf-vpn-confirmed-RELEASE_ID' >/dev/null
   ```

   This marker is human attestation, not an automated probe. Do not create it before completing that manual connectivity check.
9. Runs rollback automatically after any failed or timed-out gate.

## Post-deployment authenticated gates

Before publishing the Pages client:

- use a real Firebase-authenticated browser request to force Google JWK retrieval;
- synchronize library and wishlist with a valid SteamID/API key;
- verify a second UID cannot access the first UID's local snapshots;
- cancel a wishlist request and confirm no continued upstream traffic;
- restart the service and confirm the hashed daily quota persists;
- inspect the journal and nginx log for accidental tokens, SteamID64, API keys, request bodies, or Steam response bodies;
- confirm the manual connectivity verification marker was accepted before the installer reported success.

## Rollback

The active backup path is recorded in `/opt/steam-shelf-api/active-backup`. While a deployment can still mutate live configuration, its recovery backup is recorded in `/opt/steam-shelf-api/pending-backup`. Rollback keeps both pointers intact until every restore and verification succeeds, so an interrupted deployment or rollback can be retried. Filesystem durability barriers preserve the nginx-before-Xray listener dependency, runtime/release pointers, SELinux policy ordering, and recovery pointers across sudden power loss. SELinux port restoration is state-based and retry-safe.

```bash
# Restore Xray/nginx/systemd/SELinux state and the previous release symlink.
BACKUP=$(sudo sh -c 'if test -f /opt/steam-shelf-api/pending-backup; then cat /opt/steam-shelf-api/pending-backup; else cat /opt/steam-shelf-api/active-backup; fi')
sudo /root/steam-shelf-deploy/rollback_gateway.sh "$BACKUP"
```

Rollback immediately for failed VPN connectivity, unexpected existing-route status, nginx/Xray reload failure, SELinux AVCs, credential-like log output, repeated gateway 5xx/timeouts, or failed authenticated sync. If the Pages client has already been published, restore the prior Pages release first and retain the gateway for at least one browser-cache window before removing it.
