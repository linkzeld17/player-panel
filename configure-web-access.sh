#!/usr/bin/env bash

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "[ERROR] Administrator privileges are required." >&2
  exit 1
fi

set -Eeuo pipefail
umask 077

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$BUNDLE_DIR/scripts/lib/common.sh"

INSTALL_ROOT="/opt/player-panel"
MODE="direct"
CUSTOM_BIND=""
ASSUME_YES=0
TEST_MODE="${PLAYER_PANEL_TEST_MODE:-0}"

usage() {
  cat <<'USAGE'
Usage:
  ./configure-web-access.sh [options]

Options:
  --install-root PATH   Existing installation (default: /opt/player-panel)
  --mode MODE           proxy, direct, or custom
  --bind ADDRESS        Bind address for custom mode
  --yes                 Confirm automatically
  -h, --help            Show help

Modes:
  proxy   Listen only on 127.0.0.1; use with an HTTPS domain/reverse proxy.
  direct  Listen on 0.0.0.0; allows http://DETECTED_IP:PORT.
  custom  Use the address provided with --bind.
USAGE
}

while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:?Missing path}"; shift ;;
    --mode) MODE="${2:?Missing mode}"; shift ;;
    --bind) CUSTOM_BIND="${2:?Missing address}"; shift ;;
    --yes) ASSUME_YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done

[[ -f "$INSTALL_ROOT/.env" ]] || pp_fail "Missing $INSTALL_ROOT/.env"
[[ -f "$INSTALL_ROOT/docker-compose.yml" ]] || pp_fail "Missing $INSTALL_ROOT/docker-compose.yml"
pp_need docker
pp_need python3

env_value() {
  local key="$1"
  awk -F= -v wanted="$key" '$1==wanted {print substr($0,index($0,"=")+1); exit}' "$INSTALL_ROOT/.env"
}

update_env_key() {
  local key="$1" value="$2"
  python3 - "$INSTALL_ROOT/.env" "$key" "$value" <<'PYENV'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key, value = sys.argv[2], sys.argv[3]
lines = path.read_text('utf-8', errors='replace').splitlines()
out = []
replaced = False
for line in lines:
    if line.startswith(key + '='):
        out.append(f'{key}={value}')
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f'{key}={value}')
path.write_text('\n'.join(out).rstrip() + '\n', 'utf-8')
PYENV
}

bind_is_loopback() {
  [[ "$1" == 127.* || "$1" == "::1" || "$1" == "localhost" ]]
}

mode="${MODE,,}"
if [[ "$mode" == ask ]]; then
  current_bind="$(env_value PLAYER_PANEL_BIND_ADDRESS)"
  current_bind="${current_bind:-127.0.0.1}"
  echo "Current configuration: $current_bind:$(env_value PLAYER_PANEL_WEB_PORT)"
  echo "  [1] HTTPS domain/reverse proxy — 127.0.0.1 only (recommended)."
  echo "  [2] Direct IP/LAN access — 0.0.0.0."
  echo "  [3] Custom address."
  while true; do
    read -r -p "Select a mode [1]: " choice
    choice="${choice:-1}"
    case "$choice" in
      1) mode=proxy; break ;;
      2) mode=direct; break ;;
      3) mode=custom; break ;;
      *) pp_warn "Select 1, 2, or 3." ;;
    esac
  done
fi

case "$mode" in
  proxy)
    bind_address="127.0.0.1"
    trust_proxy="true"
    cookie_secure="$(env_value COOKIE_SECURE)"
    cookie_secure="${cookie_secure:-false}"
    ;;
  direct)
    bind_address="0.0.0.0"
    trust_proxy="true"
    cookie_secure="false"
    pp_warn "Direct HTTP access does not encrypt the password or session."
    ;;
  custom)
    if [[ -z "$CUSTOM_BIND" ]]; then
      [[ -t 0 ]] || pp_fail "Custom mode requires --bind ADDRESS."
      CUSTOM_BIND="$(pp_prompt 'Bind address' '127.0.0.1')"
    fi
    bind_address="$CUSTOM_BIND"
    if bind_is_loopback "$bind_address"; then trust_proxy=true; else trust_proxy=false; fi
    cookie_secure="$(env_value COOKIE_SECURE)"
    cookie_secure="${cookie_secure:-false}"
    ;;
  *) pp_fail "Invalid mode: $MODE. Use proxy, direct, or custom." ;;
esac

[[ "$bind_address" =~ ^[0-9a-fA-F:.]+$ || "$bind_address" == localhost ]] \
  || pp_fail "Invalid bind address: $bind_address"

stamp="$(date +%Y%m%d-%H%M%S)"
backup="$INSTALL_ROOT/.env.pre-web-access-$stamp"
cp -a "$INSTALL_ROOT/.env" "$backup"
update_env_key PLAYER_PANEL_BIND_ADDRESS "$bind_address"
update_env_key PLAYER_PANEL_WEB_ACCESS_MODE "$mode"
update_env_key TRUST_PROXY "$trust_proxy"
update_env_key COOKIE_SECURE "$cookie_secure"
chmod 0600 "$INSTALL_ROOT/.env"

if [[ "$TEST_MODE" == 1 ]]; then
  pp_ok "Test: web access configuration updated."
else
  (
    cd "$INSTALL_ROOT"
    docker compose --env-file .env up -d --force-recreate
  )
fi

web_port="$(env_value PLAYER_PANEL_WEB_PORT)"
web_port="${web_port:-8766}"
container_name="$(env_value PLAYER_PANEL_CONTAINER_NAME)"
container_name="${container_name:-player-panel-web}"

if [[ "$TEST_MODE" != 1 ]]; then
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -fsS "http://127.0.0.1:$web_port/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  (( SECONDS < deadline )) || pp_warn "The container was recreated, but healthz did not respond within 60 seconds."
fi

pp_ok "Previous configuration backed up to $backup"
pp_ok "Web access mode: $mode"
pp_ok "Docker publication: $bind_address:$web_port"

if [[ "$mode" == direct ]]; then
  echo
  host_ipv4="$(pp_detect_host_ipv4)"
  echo "Open from another device: http://$host_ipv4:$web_port"
  echo "If it does not respond, allow TCP/$web_port in the system firewall and provider/VPS firewall."
  pp_open_tcp_port "$web_port" "Player Panel"
else
  echo
  echo "The port remains restricted to the host: http://127.0.0.1:$web_port"
  echo "Publish it through an HTTPS domain and reverse proxy."
fi

if [[ "$TEST_MODE" != 1 ]]; then
  docker ps --filter "name=^/${container_name}$" --format 'Container: {{.Names}} | Ports: {{.Ports}}' || true
fi
