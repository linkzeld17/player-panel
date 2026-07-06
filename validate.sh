#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$BUNDLE_DIR/scripts/lib/common.sh"
# shellcheck source=scripts/lib/fabric-mods.sh
source "$BUNDLE_DIR/scripts/lib/fabric-mods.sh"
INSTALL_ROOT="/opt/player-panel"
CRAFTY_CONTAINER=""
SERVER_ID=""
while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift ;;
    --container) CRAFTY_CONTAINER="$2"; shift ;;
    --server-id) SERVER_ID="$2"; shift ;;
    --help|-h) echo "Usage: $0 [--install-root RUTA] [--container NOMBRE] [--server-id UUID]"; exit 0 ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done
[[ -f "$INSTALL_ROOT/.env" ]] || pp_fail "Missing $INSTALL_ROOT/.env"
set -a; source "$INSTALL_ROOT/.env"; set +a
CRAFTY_CONTAINER="${CRAFTY_CONTAINER:-${PLAYER_PANEL_API_URL#http://}}"; CRAFTY_CONTAINER="${CRAFTY_CONTAINER%%:*}"
SERVER_ID="${SERVER_ID:-${CRAFTY_SERVER_ID:-}}"
[[ -n "$SERVER_ID" ]] || pp_fail "Could not determine the UUID."

printf '=== ARCHIVOS ===\n'
for f in docker-compose.yml Dockerfile app/server.py secrets/player_panel_api_token.txt secrets/admin_password.txt secrets/session_secret.txt; do
  [[ -f "$INSTALL_ROOT/$f" ]] && pp_ok "$f" || pp_fail "Missing $f"
done
printf '\n=== PERMISOS ===\n'
for f in "$INSTALL_ROOT"/secrets/*.txt; do
  mode="$(stat -c '%a' "$f")"
  [[ "$mode" == 600 ]] && pp_ok "$(basename "$f"): 600" || pp_warn "$(basename "$f"): $mode (expected 600)"
done
printf '\n=== DOCKER ===\n'
docker inspect "${PLAYER_PANEL_CONTAINER_NAME:-player-panel-web}" >/dev/null && pp_ok "web container exists" || pp_fail "web container does not exist"
docker inspect "$CRAFTY_CONTAINER" >/dev/null && pp_ok "Crafty container exists" || pp_fail "Crafty container does not exist"
printf '\n=== WEB ===\n'
health="$(curl -fsS "http://127.0.0.1:${PLAYER_PANEL_WEB_PORT:-8766}/healthz")"
echo "$health"
grep -q '"version":"1.10.19"' <<<"$health" && pp_ok "Web 1.10.19" || pp_fail "Unexpected web version"
printf '
=== WEB ACCESS, REAL CLIENT IP, AND PROXY ===
'
trust_proxy_value="${TRUST_PROXY:-false}"
bind_address_value="${PLAYER_PANEL_BIND_ADDRESS:-127.0.0.1}"
access_mode_value="${PLAYER_PANEL_WEB_ACCESS_MODE:-}"
trusted_proxy_cidrs_value="${TRUSTED_PROXY_CIDRS:-}"
cookie_secure_value="${COOKIE_SECURE:-false}"
if [[ -z "$access_mode_value" ]]; then
  if [[ "$bind_address_value" == 127.* || "$bind_address_value" == "::1" || "$bind_address_value" == "localhost" ]]; then
    access_mode_value=proxy
  elif [[ "$bind_address_value" == "0.0.0.0" || "$bind_address_value" == "::" ]]; then
    access_mode_value=direct
  else
    access_mode_value=custom
  fi
fi
case "$access_mode_value" in
  proxy)
    [[ "$bind_address_value" == 127.* || "$bind_address_value" == "::1" || "$bind_address_value" == "localhost" ]] \
      && pp_ok "Proxy mode: publication restricted to $bind_address_value" \
      || pp_fail "Proxy mode is inconsistent with PLAYER_PANEL_BIND_ADDRESS=$bind_address_value"
    ;;
  direct)
    [[ "$bind_address_value" == "0.0.0.0" || "$bind_address_value" == "::" ]] \
      && pp_ok "Direct mode: port published on all interfaces" \
      || pp_fail "Direct mode is inconsistent with PLAYER_PANEL_BIND_ADDRESS=$bind_address_value"
    if [[ "$trust_proxy_value" =~ ^(true|1|yes|on)$ ]]; then
      [[ -n "$trusted_proxy_cidrs_value" ]] \
        && pp_ok "Direct mode: accepts headers only from proxies in TRUSTED_PROXY_CIDRS" \
        || pp_fail "TRUST_PROXY=true requires TRUSTED_PROXY_CIDRS"
    else
      pp_ok "Direct mode: uses the direct TCP IP"
    fi
    [[ ! "$cookie_secure_value" =~ ^(true|1|yes|on)$ ]] \
      && pp_ok "COOKIE_SECURE disabled for direct HTTP access" \
      || pp_fail "Direct HTTP mode requires COOKIE_SECURE=false"
    pp_warn "Direct HTTP access does not encrypt credentials; migration to an HTTPS domain is recommended."
    ;;
  custom) pp_ok "Modo personalizado: $bind_address_value" ;;
  *) pp_warn "PLAYER_PANEL_WEB_ACCESS_MODE desconocido: $access_mode_value" ;;
esac
if [[ "$trust_proxy_value" =~ ^(true|1|yes|on)$ ]]; then
  pp_ok "TRUST_PROXY habilitado"
else
  if [[ "$bind_address_value" == 127.* || "$bind_address_value" == "::1" || "$bind_address_value" == "localhost" ]]; then
    pp_fail "The panel is published only on loopback, but TRUST_PROXY is disabled; the Docker gateway will be recorded instead of the real client IP"
  fi
  pp_warn "TRUST_PROXY is disabled; the direct TCP IP will be used"
fi
if [[ -n "$trusted_proxy_cidrs_value" ]]; then
  pp_ok "Redes proxy confiables: $trusted_proxy_cidrs_value"
else
  pp_warn "TRUSTED_PROXY_CIDRS is empty; TRUST_PROXY will accept headers from any source for compatibility"
fi
container_trust="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${PLAYER_PANEL_CONTAINER_NAME:-player-panel-web}" | awk -F= '$1=="TRUST_PROXY" {print $2; exit}')"
container_cidrs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${PLAYER_PANEL_CONTAINER_NAME:-player-panel-web}" | awk -F= '$1=="TRUSTED_PROXY_CIDRS" {print substr($0,index($0,"=")+1); exit}')"
[[ "$container_trust" == "$trust_proxy_value" ]] && pp_ok "TRUST_PROXY applied to the container" || pp_fail "TRUST_PROXY in .env does not match the container; rebuild Player Panel"
[[ "$container_cidrs" == "$trusted_proxy_cidrs_value" ]] && pp_ok "TRUSTED_PROXY_CIDRS applied to the container" || pp_fail "TRUSTED_PROXY_CIDRS in .env does not match the container; rebuild Player Panel"
printf '\n=== MODS FABRIC ===\n'
server_root="/crafty/servers/$SERVER_ID"
fabric_info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" fabric-api || true)"
[[ -n "$fabric_info" ]] || pp_fail "Fabric API is not installed in $server_root/mods"
IFS=$'\t' read -r _ fabric_api_version fabric_api_path fabric_api_source <<<"$fabric_info"
[[ -n "$fabric_api_version" ]] || pp_fail "Could not validate the Fabric API version in $fabric_api_path"
pp_version_at_least "$fabric_api_version" '0.153.0' \
  && pp_ok "Fabric API $fabric_api_version ($fabric_api_source)" \
  || pp_fail "Fabric API $fabric_api_version is below the required minimum 0.153.0"

for map_id in squaremap bluemap; do
  map_info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" "$map_id" || true)"
  if [[ -n "$map_info" ]]; then
    IFS=$'\t' read -r _ map_version map_path map_source <<<"$map_info"
    pp_ok "$map_id ${map_version:-version not reported} ($map_path)"
  else
    pp_log "$map_id not installed (optional)."
  fi
done

printf '\n=== AUTHENTICATION AND WHITELIST ===\n'
docker exec -i "$CRAFTY_CONTAINER" python3 - "$SERVER_ID" "${MINECRAFT_AUTH_MODE:-}" <<'PYAUTH'
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path

root = Path('/crafty/servers') / sys.argv[1]
expected = sys.argv[2].strip().lower()
properties = root / 'server.properties'
if not properties.is_file():
    raise SystemExit(f'[FAIL] falta {properties}')

props = {}
for raw in properties.read_text('utf-8', errors='replace').splitlines():
    stripped = raw.strip()
    if stripped and not stripped.startswith('#') and '=' in raw:
        key, value = raw.split('=', 1)
        props[key.strip()] = value.strip().lower()

actual = 'offline' if props.get('online-mode', 'true') in {'false', '0', 'no', 'off'} else 'online'
print(f'Minecraft configured mode: {actual}')
if expected in {'online', 'offline'}:
    print(f'Mode declared by the web panel: {expected}')
    if actual != expected:
        raise SystemExit(f'[FAIL] the web panel uses {expected}, but server.properties uses {actual}')

if props.get('white-list') not in {'true', '1', 'yes', 'on'}:
    raise SystemExit('[FAIL] white-list is not enabled')
if props.get('enforce-whitelist') not in {'true', '1', 'yes', 'on'}:
    raise SystemExit('[FAIL] enforce-whitelist is not enabled')
print('[OK] white-list=true and enforce-whitelist=true')


def offline_uuid(name: str) -> str:
    digest = bytearray(hashlib.md5(('OfflinePlayer:' + name).encode('utf-8')).digest())
    digest[6] = (digest[6] & 0x0F) | 0x30
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


if actual == 'offline':
    whitelist = root / 'whitelist.json'
    bad = []
    if whitelist.is_file():
        try:
            payload = json.loads(whitelist.read_text('utf-8', errors='replace'))
        except json.JSONDecodeError as exc:
            raise SystemExit(f'[FAIL] whitelist.json is not valid JSON: {exc}')
        for item in payload if isinstance(payload, list) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get('name') or '').strip()
            value = str(item.get('uuid') or '').lower()
            if re.fullmatch(r'[A-Za-z0-9_]{3,16}', name):
                correct = offline_uuid(name)
                if value != correct:
                    bad.append((name, value or '(empty)', correct))
    if bad:
        for name, value, correct in bad[:20]:
            print(f'[FAIL] {name}: current UUID {value}; expected {correct}')
        raise SystemExit(f'[FAIL] hay {len(bad)} identidad(es) offline incoherentes')
    print('[OK] Whitelist UUIDs match the exact player name in offline mode')

log = root / 'logs/latest.log'
if log.is_file():
    try:
        with log.open('rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 2 * 1024 * 1024))
            text = handle.read().decode('utf-8', errors='replace')
        names = re.findall(r"Username '([A-Za-z0-9_]{3,16})' tried to join with an invalid session", text)
        if names:
            unique = list(dict.fromkeys(names[-10:]))
            print('[AVISO] Recent invalid sessions: ' + ', '.join(unique))
            if actual == 'online':
                print('[AVISO] Those attempts are rejected by authentication before the whitelist is checked.')
    except OSError:
        pass
PYAUTH

printf '\n=== PERMISOS DE MAPAS ===\n'
docker exec -i "$CRAFTY_CONTAINER" python3 - "$SERVER_ID" <<'PYMAPS'
from pathlib import Path
import os
import pwd
import stat
import sys

root = Path('/crafty/servers') / sys.argv[1]
try:
    crafty_uid = pwd.getpwnam('crafty').pw_uid
except KeyError:
    raise SystemExit('[FAIL] the crafty user does not exist inside the container')

paths = (
    root / 'config/bluemap',
    root / 'bluemap',
    root / 'bluemap/web',
    root / 'bluemap/web/maps',
    root / 'bluemap/web/lang',
    root / 'squaremap',
    root / 'config/squaremap',
)
found = False
bad = []
for path in paths:
    if not path.exists():
        continue
    found = True
    info = path.stat()
    owner_writable = info.st_uid == crafty_uid and bool(info.st_mode & stat.S_IWUSR)
    if not owner_writable:
        bad.append((path, info.st_uid, oct(stat.S_IMODE(info.st_mode))))
    else:
        print(f'[OK] {path}: owned by crafty with write access enabled')

if bad:
    for path, uid, mode in bad:
        print(f'[FAIL] {path}: uid={uid}, modo={mode}; expected crafty ownership with write access')
    raise SystemExit('[FAIL] map permissions are incompatible with the Crafty process')
if not found:
    print('[INFO] No BlueMap or squaremap directories were detected.')
PYMAPS

printf '\n=== API FABRIC ===\n'
docker exec -i "$CRAFTY_CONTAINER" python3 - "$SERVER_ID" <<'PYVALID'
from pathlib import Path
import json, sys, urllib.request
base=Path('/crafty/servers')/sys.argv[1]
config=base/'config/player-panel-fabric.properties'
if not config.is_file(): raise SystemExit(f'[FAIL] falta {config}')
props={}
for raw in config.read_text(encoding='utf-8').splitlines():
    if '=' in raw and not raw.lstrip().startswith('#'):
        k,v=raw.split('=',1); props[k.strip()]=v.strip()
port=props.get('api.port','8765'); token=props.get('security.token','')
req=urllib.request.Request(f'http://127.0.0.1:{port}/api/v1/health',headers={'Authorization':f'Bearer {token}'})
with urllib.request.urlopen(req,timeout=5) as r: data=json.load(r)
print(json.dumps(data,indent=2,ensure_ascii=False))
if r.status != 200 or data.get('success') is not True: raise SystemExit(1)
print('[OK] Fabric API available')
PYVALID
printf '\nPLAYER_PANEL_CLEAN_VALIDATION_OK\n'
