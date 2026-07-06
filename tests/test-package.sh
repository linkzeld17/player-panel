#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
find "$ROOT" -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
PYCACHE="$(mktemp -d)"
trap 'rm -rf "$PYCACHE"' EXIT
PYTHONPYCACHEPREFIX="$PYCACHE" python3 -m py_compile \
  "$ROOT/components/web/app/server.py" \
  "$ROOT/scripts/lib/crafty-server-discovery.py"
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/components/web/app/static/app.js"
  node --check "$ROOT/components/web/app/static/service-worker.js"
fi
PATTERN="link""zeld|zeld""flix|26fd""764f|895f""9a7d|H""KS"
if grep -RIni --binary-files=without-match -E "$PATTERN" "$ROOT" \
  --exclude='CHECKSUMS.sha256' --exclude='test-package.sh'; then
  echo '[FAIL] Private data or prohibited names were detected.' >&2
  exit 1
fi
if find "$ROOT" \( -name '__pycache__' -o -name '*.pyc' \) -print -quit | grep -q .; then
  echo '[FAIL] The package contains Python cache files.' >&2
  exit 1
fi
"$ROOT/tests/test-common.sh"
"$ROOT/tests/test-installer.sh"
"$ROOT/tests/test-docker-install.sh"
"$ROOT/tests/test-existing-crafty.sh"
"$ROOT/tests/test-crafty-server-discovery.sh"
"$ROOT/tests/test-unknown-crafty-server.sh"
"$ROOT/tests/test-fabric-mod-tools.sh"
"$ROOT/tests/test-auth-mode.sh"
"$ROOT/tests/test-map-connection-settings.sh"
"$ROOT/tests/test-direct-addresses.sh"
"$ROOT/tests/test-proxy-ip.sh"
"$ROOT/tests/test-web-access-mode.sh"
"$ROOT/tests/test-panel-later-empty.sh"
"$ROOT/tests/test-panel-password-validation.sh"
grep -q 'docker pull "\$CRAFTY_IMAGE"' "$ROOT/install.sh"
! grep -q 'docker compose -f compose.yml pull' "$ROOT/install.sh"
grep -q 'Initial Crafty credentials' "$ROOT/install.sh"
grep -q 'cat -- "\$creds"' "$ROOT/install.sh"
grep -q 'FABRIC_API_MIN_VERSION="0.153.0"' "$ROOT/install.sh"
grep -q 'pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" fabric-api' "$ROOT/install.sh"
grep -q 'accept-download: true' "$ROOT/install.sh"
grep -q -- '--bluemap-accept-download' "$ROOT/install.sh"
grep -q -- '--minecraft-auth-mode' "$ROOT/install.sh"
grep -q 'repair_bluemap_permissions' "$ROOT/install.sh"
grep -q 'MINECRAFT_AUTH_MODE' "$ROOT/components/web/docker-compose.yml"
grep -q 'TRUSTED_PROXY_CIDRS' "$ROOT/components/web/docker-compose.yml"
grep -q 'proxy_peer_is_trusted' "$ROOT/components/web/app/server.py"
grep -q 'offline_player_uuid' "$ROOT/components/web/app/server.py"
grep -q 'auth-repair-' "$ROOT/repair-server.sh"
grep -q 'confirm_fabric_server' "$ROOT/install.sh"
grep -q -- '--access-mode' "$ROOT/install.sh"
grep -q 'PLAYER_PANEL_WEB_ACCESS_MODE' "$ROOT/install.sh"
grep -q 'player_panel_access_url' "$ROOT/install.sh"
grep -q 'updates only Player Panel Web' "$ROOT/update-web.sh"
grep -q 'update-backups' "$ROOT/update-web.sh"
grep -q 'install-squaremap-bridge.sh' "$ROOT/update-web.sh"
grep -q 'panelThumb' "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
grep -Fq "\$('newPlaceBtn')?.addEventListener" "$ROOT/components/web/app/static/app.js"
grep -q 'handlePlaceThumbnailMessage' "$ROOT/components/web/app/static/app.js"
grep -q 'player-panel-squaremap-thumbnail' "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
grep -q "type: 'snapshot'" "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
grep -q 'imageDataUrl' "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
grep -q 'effectiveOpacity' "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
! grep -q 'context.globalAlpha = Number.isFinite(opacity)' "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
! grep -q 'MutationObserver' "$ROOT/integrations/squaremap/player-panel-squaremap-bridge-v7.js"
grep -q 'placeThumbnailQueue' "$ROOT/components/web/app/static/app.js"
grep -q 'place-thumb-snapshot' "$ROOT/components/web/app/static/styles.css"
grep -q 'pp_detect_host_ipv4' "$ROOT/scripts/lib/common.sh"
grep -q '0.0.0.0:\$CRAFTY_HTTPS_PORT:8443' "$ROOT/install.sh"
grep -q "execution_command" "$ROOT/scripts/lib/crafty-server-discovery.py"
grep -q 'load_default_crafty_credentials' "$ROOT/install.sh"
grep -q "'crafty-connections'" "$ROOT/components/web/app/static/app.js"
grep -q 'manageCraftyInstallationsBtn' "$ROOT/components/web/app/static/index.html"
grep -q 'place-coordinate-grid' "$ROOT/components/web/app/static/index.html"
grep -q 'body:not(.server-details-modal-open):not(.place-map-dialog-open)' "$ROOT/components/web/app/static/styles.css"
echo PLAYER_PANEL_CRAFTY_FIRST_LOGIN_OUTPUT_TEST_OK

grep -q -- '--setup-mode' "$ROOT/install-panel-only.sh"
grep -q 'PLAYER_PANEL_SETUP_MODE' "$ROOT/components/web/docker-compose.yml"
grep -q 'connectionOnboardingDialog' "$ROOT/components/web/app/static/index.html"
grep -q 'completeConnectionOnboarding' "$ROOT/components/web/app/static/app.js"
grep -q 'onboarding_state' "$ROOT/components/web/app/server.py"

grep -q 'if (!state.servers.length)' "$ROOT/components/web/app/static/app.js"
grep -q 'openAddServerWizard(), 180' "$ROOT/components/web/app/static/app.js"
grep -q 'squaremap 2D' "$ROOT/components/web/app/static/index.html"
grep -q 'PANEL_SETUP_MODE != "later"' "$ROOT/components/web/app/server.py"
echo PLAYER_PANEL_PACKAGE_TEST_OK
grep -q 'access_proxy_headers(plugin)' "$ROOT/components/web/app/server.py"
grep -q 'access_proxy_headers(config)' "$ROOT/components/web/app/server.py"
grep -q 'Cloudflare rejected' "$ROOT/components/web/app/server.py"
grep -q 'if configured_token:' "$ROOT/components/web/app/server.py"
! grep -q 'pluginAccessClientId' "$ROOT/components/web/app/static/index.html"
! grep -q 'craftyInstallationAccessClientId' "$ROOT/components/web/app/static/index.html"
grep -q 'plugin-lan' "$ROOT/components/web/app/static/index.html"
grep -q 'crafty-lan' "$ROOT/components/web/app/static/index.html"
grep -q 'normalizeServiceAddress' "$ROOT/components/web/app/static/app.js"
