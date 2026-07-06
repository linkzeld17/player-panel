#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
cp "$ROOT/tests/mock-docker" "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH"
export PLAYER_PANEL_TEST_MODE=1 PLAYER_PANEL_TEST_STATE="$TMP/state" PLAYER_PANEL_HOST_IP=192.0.2.10
export PLAYER_PANEL_ADMIN_PASSWORD='Clean-Test-Password-123!'
"$ROOT/install.sh" --non-interactive --yes --install-crafty --skip-maps --skip-plugin-wait \
  --container crafty-test --crafty-root "$TMP/crafty" \
  --server-id 11111111-2222-3333-4444-555555555555 \
  --minecraft-auth-mode offline \
  --plugin-port 8765 --install-root "$TMP/install" \
  --web-container player-panel-web-clean-test --web-port 18876

[[ -f "$TMP/crafty/compose.yml" ]]
[[ -f "$TMP/state/docker_pull_used" ]]
grep -qx 'arcadiatechnology/crafty-4:latest' "$TMP/state/docker_pull_image"
[[ -d "$TMP/crafty/docker/config" ]]
grep -q 'image: arcadiatechnology/crafty-4:latest' "$TMP/crafty/compose.yml"
grep -q -- '- TZ=' "$TMP/crafty/compose.yml"
grep -q '"0.0.0.0:8443:8443"' "$TMP/crafty/compose.yml"
grep -q '"0.0.0.0:25565:25565"' "$TMP/crafty/compose.yml"
grep -q '"0.0.0.0:19132:19132/udp"' "$TMP/crafty/compose.yml"
grep -q '"0.0.0.0:8100:8100"' "$TMP/crafty/compose.yml"
grep -q '"0.0.0.0:8765:8765"' "$TMP/crafty/compose.yml"
grep -q '"0.0.0.0:8110:8110"' "$TMP/crafty/compose.yml"
grep -q './docker/backups:/crafty/backups' "$TMP/crafty/compose.yml"
grep -q './docker/config:/crafty/app/config' "$TMP/crafty/compose.yml"
grep -q './docker/import:/crafty/import' "$TMP/crafty/compose.yml"
grep -q './docker/servers:/crafty/servers' "$TMP/crafty/compose.yml"
! grep -q '25500-25600' "$TMP/crafty/compose.yml"
! grep -q '/crafty/logs' "$TMP/crafty/compose.yml"
[[ -f "$TMP/install/.env" ]]
[[ -f "$TMP/install/app/server.py" ]]
[[ -f "$TMP/install/secrets/player_panel_api_token.txt" ]]
[[ "$(stat -c '%a' "$TMP/install/secrets/admin_password.txt")" == 600 ]]
grep -q '^PLAYER_PANEL_WEB_PORT=18876$' "$TMP/install/.env"
grep -q '^PLAYER_PANEL_BIND_ADDRESS=0.0.0.0$' "$TMP/install/.env"
grep -q '^PLAYER_PANEL_WEB_ACCESS_MODE=direct$' "$TMP/install/.env"
grep -q '^CRAFTY_SERVER_ID=11111111-2222-3333-4444-555555555555$' "$TMP/install/.env"
grep -q '^MINECRAFT_AUTH_MODE=offline$' "$TMP/install/.env"
grep -q '^TRUST_PROXY=true$' "$TMP/install/.env"
grep -Eq '^TZ=[A-Za-z0-9_+./-]+$' "$TMP/install/.env"
grep -q 'Docker installed by this run: 0' "$TMP/install/install-report.txt"
grep -q 'Crafty installed by this run: 1' "$TMP/install/install-report.txt"
grep -q 'Crafty image: arcadiatechnology/crafty-4:latest' "$TMP/install/install-report.txt"
grep -q 'Detected host IPv4: 192.0.2.10' "$TMP/install/install-report.txt"
grep -q 'Crafty URL: https://192.0.2.10:8443' "$TMP/install/install-report.txt"
grep -q 'Web URL: http://192.0.2.10:18876' "$TMP/install/install-report.txt"
grep -q 'Minecraft auth mode: offline' "$TMP/install/install-report.txt"
grep -q 'Secrets: REDACTED' "$TMP/install/install-report.txt"
[[ -f "$TMP/state/crafty/servers/11111111-2222-3333-4444-555555555555/mods/player-panel-1.1.7-fabric26.1.2.jar" ]]
[[ -f "$TMP/state/server_directories_prepared" ]]
[[ -f "$TMP/state/crafty/servers/11111111-2222-3333-4444-555555555555/config/player-panel-fabric.properties" ]]
echo PLAYER_PANEL_INSTALLER_FRESH_CRAFTY_MOCK_TEST_OK
