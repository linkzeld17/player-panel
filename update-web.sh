#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$BUNDLE_DIR/scripts/lib/common.sh"

INSTALL_ROOT="/opt/player-panel"
CRAFTY_CONTAINER=""
SERVER_ID=""
ASSUME_YES=0
NO_CACHE=0
SKIP_MAP_BRIDGES=0

usage() {
  cat <<'USAGE'
Usage:
  ./update-web.sh [options]

Options:
  --install-root PATH      Existing installation (default: /opt/player-panel)
  --container NAME        Crafty container used to update the squaremap web bridge
  --server-id UUID        Server UUID used to update the squaremap web bridge
  --no-cache              Rebuild the Docker image without cache
  --skip-map-bridges      Do not update map web assets
  --yes                   Confirm automatically
  -h, --help              Show this help

This script updates only Player Panel Web and its integration assets.
It does not modify server.properties, the whitelist, UUIDs, mods, or Minecraft state.
It preserves .env, data, users, sessions, passwords, tokens, and history.
USAGE
}

if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || pp_fail "Administrator privileges are required and sudo is not available."
  exec sudo -E -- "$0" "$@"
fi

while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:?Missing path}"; shift ;;
    --container) CRAFTY_CONTAINER="${2:?Missing name}"; shift ;;
    --server-id) SERVER_ID="${2:?Missing UUID}"; shift ;;
    --no-cache) NO_CACHE=1 ;;
    --skip-map-bridges) SKIP_MAP_BRIDGES=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done

pp_need docker
pp_need curl
pp_need python3
docker compose version >/dev/null 2>&1 || pp_fail "Docker Compose v2 is not available."

[[ -d "$BUNDLE_DIR/components/web/app" ]] || pp_fail "The package does not contain components/web/app."
[[ -f "$BUNDLE_DIR/components/web/docker-compose.yml" ]] || pp_fail "The package does not contain docker-compose.yml."
[[ -f "$INSTALL_ROOT/.env" ]] || pp_fail "Missing $INSTALL_ROOT/.env."
[[ -f "$INSTALL_ROOT/docker-compose.yml" ]] || pp_fail "Missing $INSTALL_ROOT/docker-compose.yml."
[[ -d "$INSTALL_ROOT/data" ]] || pp_warn "$INSTALL_ROOT/data is missing; the update will continue."

EXPECTED_VERSION="$(python3 - "$BUNDLE_DIR/components/web/app/server.py" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text('utf-8', errors='replace')
match = re.search(r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']', text, re.M)
if not match:
    raise SystemExit('Could not read APP_VERSION')
print(match.group(1))
PY
)"

if [[ "$ASSUME_YES" != 1 ]]; then
  echo "Version to install: $EXPECTED_VERSION"
  echo "Installation: $INSTALL_ROOT"
  pp_confirm "Update only Player Panel Web?" yes || exit 0
fi

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1==key {print substr($0,index($0,"=")+1); exit}' "$INSTALL_ROOT/.env"
}

CRAFTY_CONTAINER="${CRAFTY_CONTAINER:-$(read_env_value CRAFTY_CONTAINER)}"
SERVER_ID="${SERVER_ID:-$(read_env_value CRAFTY_SERVER_ID)}"
if [[ -z "$CRAFTY_CONTAINER" ]]; then
  api_host="$(read_env_value PLAYER_PANEL_API_URL)"
  api_host="${api_host#http://}"; api_host="${api_host#https://}"; api_host="${api_host%%:*}"
  CRAFTY_CONTAINER="$api_host"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$INSTALL_ROOT/update-backups/$STAMP"
mkdir -p "$BACKUP_ROOT"

WEB_ITEMS=(app Dockerfile docker-compose.yml requirements.txt .dockerignore .gitignore)
for item in "${WEB_ITEMS[@]}"; do
  [[ -e "$INSTALL_ROOT/$item" ]] && cp -a "$INSTALL_ROOT/$item" "$BACKUP_ROOT/"
done
cp -a "$INSTALL_ROOT/.env" "$BACKUP_ROOT/.env"

restore_previous_web() {
  pp_warn "Restoring the previous web version..."
  for item in "${WEB_ITEMS[@]}"; do
    rm -rf "$INSTALL_ROOT/$item"
    [[ -e "$BACKUP_ROOT/$item" ]] && cp -a "$BACKUP_ROOT/$item" "$INSTALL_ROOT/$item"
  done
  cp -a "$BACKUP_ROOT/.env" "$INSTALL_ROOT/.env"
  chmod 0600 "$INSTALL_ROOT/.env"
  (
    cd "$INSTALL_ROOT"
    docker compose --env-file .env build >/dev/null
    docker compose --env-file .env up -d --force-recreate >/dev/null
  ) || true
}

rm -rf "$INSTALL_ROOT/app"
cp -a "$BUNDLE_DIR/components/web/app" "$INSTALL_ROOT/app"
for item in Dockerfile docker-compose.yml requirements.txt .dockerignore .gitignore; do
  rm -rf "$INSTALL_ROOT/$item"
  [[ -e "$BUNDLE_DIR/components/web/$item" ]] && cp -a "$BUNDLE_DIR/components/web/$item" "$INSTALL_ROOT/$item"
done
chmod 0600 "$INSTALL_ROOT/.env"

pp_log "Rebuilding Player Panel Web $EXPECTED_VERSION..."
set +e
(
  cd "$INSTALL_ROOT"
  if [[ "$NO_CACHE" == 1 ]]; then
    docker compose --env-file .env build --no-cache
  else
    docker compose --env-file .env build
  fi
  docker compose --env-file .env up -d --force-recreate
)
build_status=$?
set -e
if ((build_status != 0)); then
  restore_previous_web
  pp_fail "The rebuild failed. An attempt was made to restore the previous version."
fi

WEB_PORT="$(read_env_value PLAYER_PANEL_WEB_PORT)"
WEB_PORT="${WEB_PORT:-8766}"
health_ok=0
deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  if health="$(curl -fsS "http://127.0.0.1:$WEB_PORT/healthz" 2>/dev/null)"; then
    if grep -q "\"version\":\"$EXPECTED_VERSION\"" <<<"$health"; then
      health_ok=1
      break
    fi
  fi
  sleep 3
done

if [[ "$health_ok" != 1 ]]; then
  restore_previous_web
  pp_fail "Version $EXPECTED_VERSION did not respond at /healthz. The previous version was restored."
fi

pp_ok "Player Panel Web $EXPECTED_VERSION updated."
pp_ok "Data and secrets preserved in $INSTALL_ROOT/data and $INSTALL_ROOT/.env."
pp_ok "Previous backup: $BACKUP_ROOT"

if [[ "$SKIP_MAP_BRIDGES" == 0 && -n "$CRAFTY_CONTAINER" && -n "$SERVER_ID" ]]; then
  if docker inspect "$CRAFTY_CONTAINER" >/dev/null 2>&1; then
    pp_log "Updating the squaremap web asset for centered thumbnails..."
    if "$BUNDLE_DIR/scripts/maps/install-squaremap-bridge.sh" "$CRAFTY_CONTAINER" "$SERVER_ID"; then
      pp_ok "squaremap web bridge updated."
    else
      pp_warn "The squaremap bridge could not be updated. The web panel still works; thumbnails will use the placeholder or an uncentered view."
    fi
  else
    pp_warn "Crafty container '$CRAFTY_CONTAINER' was not found; the squaremap bridge was skipped."
  fi
else
  pp_warn "Map bridges skipped. Use --container and --server-id to update them automatically."
fi

echo
echo "Update completed."
echo "Verification: http://127.0.0.1:$WEB_PORT/healthz"
