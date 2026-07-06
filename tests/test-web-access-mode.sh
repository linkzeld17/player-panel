#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/install" "$TMP/state"
cp "$ROOT/tests/mock-docker" "$TMP/bin/docker"
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH"
export PLAYER_PANEL_TEST_MODE=1 PLAYER_PANEL_TEST_STATE="$TMP/state" PLAYER_PANEL_HOST_IP=192.0.2.10
cat > "$TMP/install/.env" <<'ENV'
PLAYER_PANEL_CONTAINER_NAME=player-panel-web-test
PLAYER_PANEL_BIND_ADDRESS=127.0.0.1
PLAYER_PANEL_WEB_ACCESS_MODE=proxy
PLAYER_PANEL_WEB_PORT=18766
TRUST_PROXY=true
COOKIE_SECURE=true
ENV
: > "$TMP/install/docker-compose.yml"

"$ROOT/configure-web-access.sh" --install-root "$TMP/install" --mode direct --yes
grep -q '^PLAYER_PANEL_BIND_ADDRESS=0.0.0.0$' "$TMP/install/.env"
grep -q '^PLAYER_PANEL_WEB_ACCESS_MODE=direct$' "$TMP/install/.env"
grep -q '^TRUST_PROXY=true$' "$TMP/install/.env"
grep -q '^COOKIE_SECURE=false$' "$TMP/install/.env"
ls "$TMP/install"/.env.pre-web-access-* >/dev/null

"$ROOT/configure-web-access.sh" --install-root "$TMP/install" --mode proxy --yes
grep -q '^PLAYER_PANEL_BIND_ADDRESS=127.0.0.1$' "$TMP/install/.env"
grep -q '^PLAYER_PANEL_WEB_ACCESS_MODE=proxy$' "$TMP/install/.env"
grep -q '^TRUST_PROXY=true$' "$TMP/install/.env"

echo PLAYER_PANEL_WEB_ACCESS_MODE_TEST_OK
