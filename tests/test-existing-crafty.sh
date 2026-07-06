#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
cp "$ROOT/tests/mock-docker" "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
touch "$TMP/state/crafty_present" "$TMP/state/network_present"
export PATH="$TMP/bin:$PATH"
export PLAYER_PANEL_TEST_MODE=1 PLAYER_PANEL_TEST_STATE="$TMP/state"
export PLAYER_PANEL_ADMIN_PASSWORD='Clean-Test-Password-123!'
"$ROOT/install.sh" --non-interactive --yes --skip-maps --skip-plugin-wait \
  --container crafty-test \
  --server-id 11111111-2222-3333-4444-555555555555 \
  --plugin-port 8765 --install-root "$TMP/install" \
  --web-container player-panel-web-existing-test --web-port 18879

grep -q 'Crafty installed by this run: 0' "$TMP/install/install-report.txt"
grep -q 'Crafty container: crafty-test' "$TMP/install/install-report.txt"
echo PLAYER_PANEL_EXISTING_CRAFTY_MOCK_TEST_OK
