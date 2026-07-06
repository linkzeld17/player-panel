#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$BUNDLE_DIR/scripts/lib/common.sh"
INSTALL_ROOT="/opt/player-panel"
REMOVE_FABRIC=0
CRAFTY_CONTAINER=""
SERVER_ID=""
while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift ;;
    --remove-fabric) REMOVE_FABRIC=1 ;;
    --container) CRAFTY_CONTAINER="$2"; shift ;;
    --server-id) SERVER_ID="$2"; shift ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done
[[ -d "$INSTALL_ROOT" ]] || pp_fail "Missing $INSTALL_ROOT"
if [[ -f "$INSTALL_ROOT/.env" ]]; then set -a; source "$INSTALL_ROOT/.env"; set +a; fi
backup="${INSTALL_ROOT}.uninstalled-$(date +%Y%m%d-%H%M%S)"
(cd "$INSTALL_ROOT" && docker compose --env-file .env down) || true
mv "$INSTALL_ROOT" "$backup"
pp_ok "Web panel stopped and moved to $backup"
if ((REMOVE_FABRIC)); then
  CRAFTY_CONTAINER="${CRAFTY_CONTAINER:-${PLAYER_PANEL_API_URL#http://}}"; CRAFTY_CONTAINER="${CRAFTY_CONTAINER%%:*}"
  SERVER_ID="${SERVER_ID:-${CRAFTY_SERVER_ID:-}}"
  [[ -n "$CRAFTY_CONTAINER" && -n "$SERVER_ID" ]] || pp_fail "Indique --container y --server-id."
  root="/crafty/servers/$SERVER_ID"
  docker exec "$CRAFTY_CONTAINER" sh -lc "mkdir -p '$root/player-panel-backups/uninstall-$(date +%Y%m%d-%H%M%S)'; mv '$root'/mods/player-panel-*.jar '$root/player-panel-backups/' 2>/dev/null || true"
  pp_ok "Fabric JAR removed. Configuration was preserved."
fi
