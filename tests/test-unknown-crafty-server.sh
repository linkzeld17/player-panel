#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$ROOT/install-report.txt"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
cp "$ROOT/tests/mock-docker" "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
touch "$TMP/state/crafty_present" "$TMP/state/network_present" "$TMP/state/unknown_server_type"
export PATH="$TMP/bin:$PATH"
export PLAYER_PANEL_TEST_MODE=1 PLAYER_PANEL_TEST_STATE="$TMP/state"

# 1 selects the only server; Enter accepts the explicit Fabric confirmation.
printf '1\n\n' | "$ROOT/install.sh" --yes --skip-maps --skip-plugin-wait --skip-web \
  --container crafty-test \
  --minecraft-auth-mode offline \
  --plugin-port 8765 \
  --install-root "$TMP/install" | tee "$TMP/output.log"

grep -q "Server: Clean Test Server (11111111-2222-3333-4444-555555555555)" "$TMP/output.log"
grep -q 'Minecraft authentication: offline' "$TMP/output.log"
grep -q 'Bundle: 1.0.0-beta.1' "$ROOT/install-report.txt"
[[ -f "$TMP/state/crafty/servers/11111111-2222-3333-4444-555555555555/mods/player-panel-1.1.7-fabric26.1.2.jar" ]]
echo PLAYER_PANEL_UNKNOWN_CRAFTY_SERVER_TEST_OK
