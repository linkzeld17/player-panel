# Full guided installation

This path installs Player Panel Web and connects it to a local Crafty Controller deployment and a Fabric server.

## Before you begin

- Use Ubuntu 22.04/24.04 or Debian 12 when possible.
- Create a backup of Crafty and the Minecraft server.
- Ensure the selected Minecraft server is Fabric 26.1.2.
- The installer must be able to write to `/opt/player-panel` and, when installing Crafty, `/opt/crafty`.
- Stop the Minecraft server when the installer asks. Do not stop Crafty unless specifically instructed.

## Extract the release

If the ZIP was downloaded to `/home/YOUR_USER`, move it to `/root` first:

```bash
mv /home/YOUR_USER/player-panel-1.0.0-beta.1.zip /root/
cd /root
unzip player-panel-1.0.0-beta.1.zip
cd player-panel-1.0.0-beta.1
```

Make scripts executable and verify the package:

```bash
chmod +x \
  install.sh install-panel-only.sh update-web.sh repair-server.sh \
  configure-web-access.sh validate.sh uninstall.sh \
  scripts/lib/*.sh scripts/lib/*.py scripts/maps/*.sh \
  tests/*.sh tests/mock-docker

sha256sum -c CHECKSUMS.sha256
./tests/test-package.sh
```

## Run the installer

```bash
./install.sh
```

The installer guides you through:

1. Docker detection or installation.
2. Existing Crafty detection or a new Crafty deployment.
3. Crafty first login and Fabric server selection.
4. Minecraft authentication mode:
   - **online** for official Microsoft/Mojang sessions;
   - **offline** for environments that intentionally do not validate official sessions;
   - **keep** to preserve the current setting.
5. Whitelist enforcement.
6. Fabric API verification and installation when required.
7. Optional squaremap and BlueMap installation.
8. Player Panel Fabric mod installation.
9. BlueMap asset consent after the first server start.
10. Player Panel Web installation.

## BlueMap asset consent

BlueMap generates `config/bluemap/core.conf` after its first server start. The installer then asks whether it may set:

```text
accept-download: true
```

This is a separate consent step. In non-interactive deployments, add:

```bash
--bluemap-accept-download
```

or set:

```bash
BLUEMAP_ACCEPT_DOWNLOAD=true
```

## Non-interactive example

```bash
PLAYER_PANEL_ADMIN_PASSWORD='replace-with-a-strong-password' \
./install.sh \
  --non-interactive \
  --yes \
  --install-crafty \
  --minecraft-auth-mode online
```

Use `--minecraft-auth-mode offline` only when you understand the identity and impersonation implications of offline mode.

## After installation

The installer prints detected URLs similar to:

```text
Crafty: https://192.0.2.10:8443
Player Panel: http://192.0.2.10:8766
```

Verify the web service:

```bash
curl -fsS http://127.0.0.1:8766/healthz
```

Expected response:

```json
{"status":"ok","version":"1.10.19"}
```

Run the installed-system validator:

```bash
./validate.sh \
  --install-root /opt/player-panel \
  --container crafty-controller \
  --server-id YOUR_SERVER_UUID
```

## Public deployment

Direct HTTP access is useful for setup but does not encrypt credentials or session cookies. For permanent public access:

1. point a domain at the server;
2. place Nginx, Nginx Proxy Manager, Caddy, Traefik, or Cloudflare Tunnel in front of `127.0.0.1:8766`;
3. enable HTTPS;
4. switch Player Panel to proxy mode:

```bash
./configure-web-access.sh --mode proxy --yes
```
