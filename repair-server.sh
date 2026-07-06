#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$BUNDLE_DIR/scripts/lib/common.sh"

INSTALL_ROOT="/opt/player-panel"
CRAFTY_CONTAINER=""
SERVER_ID=""
AUTH_MODE="ask"
ASSUME_YES=0
SKIP_WEB_UPDATE=0

usage() {
  cat <<'USAGE'
Usage:
  ./repair-server.sh [opciones]

Options:
  --install-root PATH          Existing web installation (default: /opt/player-panel)
  --container NAME            Crafty container
  --server-id UUID            Minecraft server UUID
  --auth-mode MODE            online, offline, keep, or ask
  --skip-web-update            Do not update Player Panel Web
  --yes                        Confirm the repair automatically
  -h, --help                   Show this help

The repair:
  - configures online-mode/whitelist consistently;
  - fixes offline UUIDs using the exact player name;
  - normalizes BlueMap/squaremap permissions for the crafty user;
  - updates the web panel to the version included in this package while preserving data and secrets.
USAGE
}

if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || pp_fail "Administrator privileges are required and sudo is not available."
  exec sudo -E -- "$0" "$@"
fi

while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:?Missing ruta}"; shift ;;
    --container) CRAFTY_CONTAINER="${2:?Missing name}"; shift ;;
    --server-id) SERVER_ID="${2:?Missing UUID}"; shift ;;
    --auth-mode) AUTH_MODE="${2:?Missing modo}"; shift ;;
    --skip-web-update) SKIP_WEB_UPDATE=1 ;;
    --yes) ASSUME_YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done

case "${AUTH_MODE,,}" in
  ask|keep|online|offline) ;;
  *) pp_fail "Invalid mode: $AUTH_MODE. Use online, offline, keep, or ask." ;;
esac

pp_need docker
pp_need python3

env_container=""
env_server_id=""
if [[ -f "$INSTALL_ROOT/.env" ]]; then
  env_container="$(awk -F= '$1=="PLAYER_PANEL_API_URL" {sub(/^https?:\/\//,"",$2); sub(/:.*/,"",$2); print $2; exit}' "$INSTALL_ROOT/.env")"
  env_server_id="$(awk -F= '$1=="CRAFTY_SERVER_ID" {print substr($0,index($0,"=")+1); exit}' "$INSTALL_ROOT/.env")"
fi
CRAFTY_CONTAINER="${CRAFTY_CONTAINER:-$env_container}"
SERVER_ID="${SERVER_ID:-$env_server_id}"

if [[ -z "$CRAFTY_CONTAINER" ]]; then
  mapfile -t crafty_candidates < <(
    docker ps -a --format '{{.Names}}' | while IFS= read -r name; do
      image="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || true)"
      [[ "$image" == *crafty* ]] && printf '%s\n' "$name"
    done
  )
  ((${#crafty_candidates[@]})) || pp_fail "No Crafty container was detected. Use --container."
  if ((${#crafty_candidates[@]} == 1)); then
    CRAFTY_CONTAINER="${crafty_candidates[0]}"
  else
    echo "Detected Crafty containers:"
    for i in "${!crafty_candidates[@]}"; do printf '  [%d] %s\n' "$((i + 1))" "${crafty_candidates[$i]}"; done
    while true; do
      read -r -p "Select the container: " choice
      [[ "$choice" =~ ^[0-9]+$ ]] && ((choice >= 1 && choice <= ${#crafty_candidates[@]})) || continue
      CRAFTY_CONTAINER="${crafty_candidates[$((choice - 1))]}"
      break
    done
  fi
fi

docker inspect "$CRAFTY_CONTAINER" >/dev/null 2>&1 || pp_fail "Missing container $CRAFTY_CONTAINER."
[[ "$(docker inspect -f '{{.State.Running}}' "$CRAFTY_CONTAINER" 2>/dev/null || true)" == true ]] || {
  pp_log "Starting Crafty container: $CRAFTY_CONTAINER"
  docker start "$CRAFTY_CONTAINER" >/dev/null
}

if [[ -z "$SERVER_ID" ]]; then
  mapfile -t server_ids < <(docker exec "$CRAFTY_CONTAINER" sh -lc "find /crafty/servers -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | grep -E '^[0-9a-fA-F-]{36}$' | sort")
  ((${#server_ids[@]})) || pp_fail "No servers were found under /crafty/servers. Use --server-id."
  if ((${#server_ids[@]} == 1)); then
    SERVER_ID="${server_ids[0]}"
  else
    echo "Detected servers:"
    for i in "${!server_ids[@]}"; do printf '  [%d] %s\n' "$((i + 1))" "${server_ids[$i]}"; done
    while true; do
      read -r -p "Select the UUID: " choice
      [[ "$choice" =~ ^[0-9]+$ ]] && ((choice >= 1 && choice <= ${#server_ids[@]})) || continue
      SERVER_ID="${server_ids[$((choice - 1))]}"
      break
    done
  fi
fi

[[ "$SERVER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || pp_fail "Invalid server UUID: $SERVER_ID"
SERVER_ROOT="/crafty/servers/$SERVER_ID"
docker exec "$CRAFTY_CONTAINER" test -f "$SERVER_ROOT/server.properties" \
  || pp_fail "Missing $SERVER_ROOT/server.properties."

server_running() {
  docker exec -i "$CRAFTY_CONTAINER" python3 - "$SERVER_ROOT" <<'PYRUN'
from pathlib import Path
import os, sys
root = Path(sys.argv[1])
running = False
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        if Path(os.readlink(proc / 'cwd')) == root:
            running = True
            break
    except OSError:
        pass
raise SystemExit(0 if running else 1)
PYRUN
}

while server_running; do
  pp_warn "The Minecraft server is running. Stop it from Crafty before modifying properties and identities."
  [[ -t 0 ]] || pp_fail "Server is running. Stop it from Crafty and run the repair again."
  read -r -p "When it shows as Stopped, press Enter to check... " _
done

current_mode="$(docker exec -i "$CRAFTY_CONTAINER" python3 - "$SERVER_ROOT/server.properties" <<'PYMODE'
from pathlib import Path
import sys
value = 'true'
for raw in Path(sys.argv[1]).read_text('utf-8', errors='replace').splitlines():
    line = raw.strip()
    if line and not line.startswith('#') and '=' in line:
        key, item = line.split('=', 1)
        if key.strip() == 'online-mode':
            value = item.strip().lower()
            break
print('offline' if value in {'false', '0', 'no', 'off'} else 'online')
PYMODE
)"

resolved_mode="${AUTH_MODE,,}"
if [[ "$resolved_mode" == ask ]]; then
  echo
  echo "Current mode: $current_mode"
  echo "  [1] Online  - requires a valid official session."
  echo "  [2] Offline - allows launchers without an official session and uses UUIDs derived from the exact player name."
  echo "  [3] Mantener $current_mode."
  while true; do
    read -r -p "Select the mode [3]: " choice
    choice="${choice:-3}"
    case "$choice" in
      1) resolved_mode=online; break ;;
      2) resolved_mode=offline; break ;;
      3) resolved_mode="$current_mode"; break ;;
      *) pp_warn "Select 1, 2, or 3." ;;
    esac
  done
elif [[ "$resolved_mode" == keep ]]; then
  resolved_mode="$current_mode"
fi

if [[ "$resolved_mode" == offline ]]; then
  pp_warn "In offline mode, the server does not verify ownership of player names. Keep the whitelist enabled and preserve exact capitalization."
fi

if [[ "$ASSUME_YES" != 1 ]]; then
  pp_confirm "Apply the repair to server $SERVER_ID in mode $resolved_mode?" yes || exit 0
fi

result="$(docker exec -i "$CRAFTY_CONTAINER" python3 - "$SERVER_ROOT" "$resolved_mode" <<'PYREPAIR'
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import uuid
from datetime import datetime
from pathlib import Path

root = Path(sys.argv[1])
mode = sys.argv[2]
properties = root / 'server.properties'
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = root / 'player-panel-backups' / f'auth-repair-{stamp}'
backup.mkdir(parents=True, exist_ok=True)

for filename in ('server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'usercache.json'):
    source = root / filename
    if source.is_file():
        shutil.copy2(source, backup / filename)

lines = properties.read_text('utf-8', errors='replace').splitlines()
required = {
    'online-mode': 'true' if mode == 'online' else 'false',
    'white-list': 'true',
    'enforce-whitelist': 'true',
}
if mode == 'offline':
    required['enforce-secure-profile'] = 'false'

seen: set[str] = set()
updated: list[str] = []
for raw in lines:
    stripped = raw.strip()
    if stripped and not stripped.startswith('#') and '=' in raw:
        key = raw.split('=', 1)[0].strip()
        if key in required:
            updated.append(f'{key}={required[key]}')
            seen.add(key)
            continue
    updated.append(raw)
for key, value in required.items():
    if key not in seen:
        updated.append(f'{key}={value}')
properties.write_text('\n'.join(updated).rstrip() + '\n', 'utf-8')


def offline_uuid(name: str) -> str:
    digest = bytearray(hashlib.md5(('OfflinePlayer:' + name).encode('utf-8')).digest())
    digest[6] = (digest[6] & 0x0F) | 0x30
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))

# Preserve capitalization from the most recent attempt. This matters because
# the offline UUID is calculated from the exact name, not lower(name).
observed: dict[str, str] = {}
log = root / 'logs' / 'latest.log'
if log.is_file():
    try:
        with log.open('rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 4 * 1024 * 1024))
            text = handle.read().decode('utf-8', errors='replace')
        patterns = (
            re.compile(r"Username '([A-Za-z0-9_]{3,16})' tried to join with an invalid session"),
            re.compile(r"Disconnecting ([A-Za-z0-9_]{3,16}) \([^)]*\): Failed to verify username!"),
        )
        for line in text.splitlines():
            for pattern in patterns:
                match = pattern.search(line)
                if match:
                    observed[match.group(1).lower()] = match.group(1)
    except OSError:
        pass

repaired = 0
renamed = 0
entries: list[tuple[str, str]] = []
if mode == 'offline':
    for filename in ('whitelist.json', 'ops.json', 'banned-players.json', 'usercache.json'):
        path = root / filename
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text('utf-8', errors='replace'))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, list):
            continue
        dirty = False
        for item in payload:
            if not isinstance(item, dict):
                continue
            name = str(item.get('name') or '').strip()
            if not re.fullmatch(r'[A-Za-z0-9_]{3,16}', name):
                continue
            exact = observed.get(name.lower(), name)
            expected = offline_uuid(exact)
            if exact != name:
                item['name'] = exact
                name = exact
                renamed += 1
                dirty = True
            if str(item.get('uuid') or '').lower() != expected:
                item['uuid'] = expected
                repaired += 1
                dirty = True
            if filename == 'whitelist.json':
                entries.append((name, expected))
        if dirty:
            path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', 'utf-8')

print(f'BACKUP={backup}')
print(f'REPAIRED={repaired}')
print(f'RENAMED={renamed}')
for name, value in entries:
    print(f'ENTRY={name}\t{value}')
PYREPAIR
)"

backup="$(awk -F= '$1=="BACKUP" {sub(/^BACKUP=/,""); print; exit}' <<<"$result")"
repaired="$(awk -F= '$1=="REPAIRED" {print $2; exit}' <<<"$result")"
renamed="$(awk -F= '$1=="RENAMED" {print $2; exit}' <<<"$result")"

# Minecraft and mods run as crafty inside the container.
docker exec "$CRAFTY_CONTAINER" sh -lc "
  set -eu
  chown crafty:root '$SERVER_ROOT/server.properties' 2>/dev/null || true
  chmod 0644 '$SERVER_ROOT/server.properties'
  for file in '$SERVER_ROOT'/whitelist.json '$SERVER_ROOT'/ops.json '$SERVER_ROOT'/banned-players.json '$SERVER_ROOT'/usercache.json; do
    [ -f \"\$file\" ] || continue
    chown crafty:root \"\$file\" 2>/dev/null || true
    chmod 0644 \"\$file\"
  done
  for path in '$SERVER_ROOT/config/bluemap' '$SERVER_ROOT/bluemap' '$SERVER_ROOT/squaremap' '$SERVER_ROOT/config/squaremap'; do
    [ -e \"\$path\" ] || continue
    chown -R crafty:root \"\$path\" 2>/dev/null || true
    find \"\$path\" -type d -exec chmod 0775 {} + 2>/dev/null || true
    find \"\$path\" -type f -exec chmod 0664 {} + 2>/dev/null || true
  done
"

pp_ok "Minecraft mode configured: $resolved_mode"
pp_ok "UUID offline corregidos: ${repaired:-0}; nombres ajustados: ${renamed:-0}"
pp_ok "BlueMap and squaremap permissions normalized."
pp_ok "Server backup: $backup"

if [[ "$resolved_mode" == offline ]]; then
  echo
  echo "Repaired whitelist:"
  awk -F= '$1=="ENTRY" {sub(/^ENTRY=/,""); print "  " $0}' <<<"$result"
fi

update_env_key() {
  local file="$1" key="$2" value="$3"
  python3 - "$file" "$key" "$value" <<'PYENV'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text('utf-8', errors='replace').splitlines() if path.is_file() else []
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

trusted_proxy_cidrs_for_network() {
  local network_name="$1" subnet result="127.0.0.0/8,::1/128"
  while IFS= read -r subnet; do
    subnet="${subnet//$'\r'/}"
    [[ -n "$subnet" ]] || continue
    result+=",$subnet"
  done < <(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$network_name" 2>/dev/null || true)
  printf '%s' "$result"
}

if [[ "$SKIP_WEB_UPDATE" == 0 ]]; then
  if [[ -f "$INSTALL_ROOT/.env" && -f "$INSTALL_ROOT/docker-compose.yml" ]]; then
    pp_need curl
    docker compose version >/dev/null 2>&1 || pp_fail "Docker Compose v2 is not available."
    web_backup="$INSTALL_ROOT/repair-backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$web_backup"
    for item in app Dockerfile docker-compose.yml requirements.txt .dockerignore .gitignore; do
      [[ -e "$INSTALL_ROOT/$item" ]] && cp -a "$INSTALL_ROOT/$item" "$web_backup/"
    done

    rm -rf "$INSTALL_ROOT/app"
    cp -a "$BUNDLE_DIR/components/web/app" "$INSTALL_ROOT/app"
    for item in Dockerfile docker-compose.yml requirements.txt .dockerignore .gitignore; do
      [[ -e "$BUNDLE_DIR/components/web/$item" ]] && cp -a "$BUNDLE_DIR/components/web/$item" "$INSTALL_ROOT/$item"
    done
    update_env_key "$INSTALL_ROOT/.env" MINECRAFT_AUTH_MODE "$resolved_mode"

    proxy_network="$(awk -F= '$1=="PLAYER_PANEL_NETWORK" {print substr($0,index($0,"=")+1); exit}' "$INSTALL_ROOT/.env")"
    proxy_network="${proxy_network:-player-panel-net}"
    docker network inspect "$proxy_network" >/dev/null 2>&1 || docker network create "$proxy_network" >/dev/null
    trusted_proxy_cidrs="$(trusted_proxy_cidrs_for_network "$proxy_network")"
    bind_address="$(awk -F= '$1=="PLAYER_PANEL_BIND_ADDRESS" {print substr($0,index($0,"=")+1); exit}' "$INSTALL_ROOT/.env")"
    current_trust_proxy="$(awk -F= '$1=="TRUST_PROXY" {print tolower(substr($0,index($0,"=")+1)); exit}' "$INSTALL_ROOT/.env")"
    if [[ "$bind_address" == 127.* || "$bind_address" == "::1" || "$bind_address" == "localhost" ]]; then
      current_trust_proxy=true
    fi
    current_trust_proxy="${current_trust_proxy:-false}"
    update_env_key "$INSTALL_ROOT/.env" TRUST_PROXY "$current_trust_proxy"
    update_env_key "$INSTALL_ROOT/.env" TRUSTED_PROXY_CIDRS "$trusted_proxy_cidrs"
    chmod 0600 "$INSTALL_ROOT/.env"

    pp_log "Rebuilding Player Panel Web with real proxy IP support and UUID support for mode $resolved_mode..."
    (
      cd "$INSTALL_ROOT"
      docker compose --env-file .env build
      docker compose --env-file .env up -d
    )

    web_port="$(awk -F= '$1=="PLAYER_PANEL_WEB_PORT" {print $2; exit}' "$INSTALL_ROOT/.env")"
    web_port="${web_port:-8766}"
    deadline=$((SECONDS + 120))
    while ((SECONDS < deadline)); do
      if health="$(curl -fsS "http://127.0.0.1:$web_port/healthz" 2>/dev/null)"; then
        if grep -q '"version":"1.10.19"' <<<"$health"; then
          pp_ok "Player Panel Web 1.10.19 updated and available."
          pp_ok "Proxy confiable: $current_trust_proxy; redes: $trusted_proxy_cidrs"
          break
        fi
      fi
      sleep 3
    done
    ((SECONDS < deadline)) || pp_warn "The web panel was rebuilt but did not respond within 120 seconds. Check docker compose logs."
    pp_ok "Previous web backup: $web_backup"
  else
    pp_warn "A complete web installation was not found in $INSTALL_ROOT; its update was skipped."
  fi
fi

echo
echo "=== SIGUIENTE PASO ==="
echo "1. Start the Minecraft server from Crafty."
if [[ "$resolved_mode" == offline ]]; then
  echo "2. Join using exactly the same name shown in the whitelist."
  echo "3. A name not present in the whitelist will reach validation and generate the corresponding alert."
else
  echo "2. Sign in with a valid official Microsoft/Mojang session."
fi
echo "4. BlueMap will recreate or update its web files with correct write permissions."
