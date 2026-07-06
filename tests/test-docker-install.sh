#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
export PATH="$TMP/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PLAYER_PANEL_TEST_MODE=1 PLAYER_PANEL_TEST_STATE="$TMP/state" PLAYER_PANEL_TEST_BIN="$TMP/bin"
export PLAYER_PANEL_ADMIN_PASSWORD='Clean-Test-Password-123!'
"$ROOT/install.sh" --non-interactive --yes --install-crafty --skip-maps --skip-plugin-wait \
  --container crafty-test --crafty-root "$TMP/crafty" \
  --server-id 11111111-2222-3333-4444-555555555555 \
  --plugin-port 8765 --install-root "$TMP/install" \
  --web-container player-panel-web-docker-test --web-port 18878

[[ -x "$TMP/bin/docker" ]]
grep -q 'Docker installed by this run: 1' "$TMP/install/install-report.txt"
grep -q 'Crafty installed by this run: 1' "$TMP/install/install-report.txt"
echo PLAYER_PANEL_DOCKER_AUTO_INSTALL_MOCK_TEST_OK
