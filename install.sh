#!/usr/bin/env bash

# Elevates privileges in one execution. It does not open an interactive sudo -i shell.
if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1; then
    echo "[INFO] Administrative privileges are required; continuing with sudo..."
    exec sudo -E bash "$0" "$@"
  fi
  echo "[ERROR] Run this installer as root or install sudo." >&2
  exit 1
fi

set -Eeuo pipefail
umask 077

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$BUNDLE_DIR/scripts/lib/common.sh"
# shellcheck source=scripts/lib/fabric-mods.sh
source "$BUNDLE_DIR/scripts/lib/fabric-mods.sh"

BUNDLE_VERSION="1.0.0-beta.1"
WEB_VERSION="1.10.19"
FABRIC_VERSION="1.1.7"
MC_VERSION="26.1.2"

FABRIC_API_MIN_VERSION="0.153.0"
FABRIC_API_VERSION="0.153.0+26.1.2"
FABRIC_API_FILE="fabric-api-0.153.0+26.1.2.jar"
FABRIC_API_URL="https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.153.0%2B26.1.2/fabric-api-0.153.0%2B26.1.2.jar"
FABRIC_API_SHA256="2a604ccc66c1294f860acb8d0763c8887e927b3ed34aa262ac79e26d8626b94c"

SQUAREMAP_VERSION="1.3.13"
SQUAREMAP_FILE="squaremap-fabric-mc26.1.2-1.3.13.jar"
SQUAREMAP_URL="https://github.com/jpenilla/squaremap/releases/download/v1.3.13/squaremap-fabric-mc26.1.2-1.3.13.jar"
SQUAREMAP_SHA256="b3e8fc558c322e6fc8b47073ae878725612f5c52aa5a8caa1c2bc4bc38f33211"

BLUEMAP_VERSION="5.20"
BLUEMAP_FILE="bluemap-5.20-fabric.jar"
BLUEMAP_URL="https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v5.20/bluemap-5.20-fabric.jar"

PP_NON_INTERACTIVE=0
ASSUME_YES=0
FORCE=0
SKIP_FABRIC=0
SKIP_WEB=0
SKIP_MAPS=0
SKIP_PLUGIN_WAIT=0
SKIP_CRAFTY=0
FORCE_CRAFTY_INSTALL=0
TEST_MODE="${PLAYER_PANEL_TEST_MODE:-0}"

INSTALL_ROOT="${PLAYER_PANEL_INSTALL_ROOT:-/opt/player-panel}"
CRAFTY_ROOT="${CRAFTY_INSTALL_ROOT:-/opt/crafty}"
CRAFTY_IMAGE="${CRAFTY_IMAGE:-arcadiatechnology/crafty-4:latest}"
CRAFTY_CONTAINER="${CRAFTY_CONTAINER:-crafty-controller}"
CRAFTY_HTTPS_PORT="${CRAFTY_HTTPS_PORT:-8443}"
CRAFTY_BLUEMAP_PORT="${CRAFTY_BLUEMAP_PORT:-8100}"
CRAFTY_SQUAREMAP_PORT="${CRAFTY_SQUAREMAP_PORT:-8110}"
CRAFTY_BEDROCK_PORT="${CRAFTY_BEDROCK_PORT:-19132}"
CRAFTY_MC_PORT="${CRAFTY_MC_PORT:-25565}"
CRAFTY_PLAYER_PANEL_PORT="${CRAFTY_PLAYER_PANEL_PORT:-8765}"
CRAFTY_INSTALLED_BY_SCRIPT=0
CRAFTY_PULL_RETRIES="${CRAFTY_PULL_RETRIES:-1}"
DOCKER_INSTALLED_BY_SCRIPT=0
SERVER_ID="${PLAYER_PANEL_SERVER_ID:-}"
PLUGIN_PORT="${PLAYER_PANEL_PLUGIN_PORT:-}"
WEB_PORT="${PLAYER_PANEL_WEB_PORT:-8766}"
BIND_ADDRESS="${PLAYER_PANEL_BIND_ADDRESS:-0.0.0.0}"
WEB_ACCESS_MODE="${PLAYER_PANEL_WEB_ACCESS_MODE:-direct}"
WEB_ACCESS_MODE_RESOLVED=""
WEB_CONTAINER="${PLAYER_PANEL_CONTAINER_NAME:-player-panel-web}"
NETWORK="${PLAYER_PANEL_NETWORK:-player-panel-net}"
TIMEZONE_NAME="${PLAYER_PANEL_TIMEZONE:-}"
TIMEZONE_RESOLVED=0
TIMEZONE_ORIGIN=""
PUBLIC_URL="${PLAYER_PANEL_PUBLIC_URL:-}"
VAPID_SUBJECT_VALUE="${VAPID_SUBJECT:-}"
CRAFTY_PANEL_URL_VALUE="${CRAFTY_PANEL_URL:-}"
CRAFTY_USER_VALUE="${CRAFTY_USERNAME:-}"
CRAFTY_PASSWORD_VALUE="${CRAFTY_PASSWORD:-}"
CRAFTY_TOKEN_VALUE="${CRAFTY_API_TOKEN:-}"
CONFIG_FILE=""
BLUEMAP_ACCEPT_DOWNLOAD="${BLUEMAP_ACCEPT_DOWNLOAD:-ask}"
MINECRAFT_AUTH_MODE="${MINECRAFT_AUTH_MODE:-ask}"
MINECRAFT_AUTH_MODE_RESOLVED=""
MINECRAFT_AUTH_MODE_CHANGED=0
OFFLINE_IDENTITIES_REPAIRED=0
FABRIC_API_DETECTED_VERSION=""
SQUAREMAP_DETECTED_VERSION=""
BLUEMAP_DETECTED_VERSION=""
SQUAREMAP_INSTALLED_BY_SCRIPT=0
BLUEMAP_INSTALLED_BY_SCRIPT=0
BLUEMAP_ASSETS_ACCEPTED=0
MAP_RESTART_REQUIRED=0
HOST_IPV4=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Clean interactive installer for Player Panel.

Main options:
  --non-interactive       Do not prompt; use environment variables/options.
  --yes                   Accept safe confirmations.
  --config FILE           Load allowed KEY=VALUE settings.
  --install-root PATH     Installation path (default: /opt/player-panel).
  --container NAME        Crafty container name.
  --install-crafty        Install Crafty even when no existing instance is detected.
  --skip-crafty           Do not install Crafty when missing; exit unchanged.
  --crafty-root PATH      Persistent Crafty path (default: /opt/crafty).
  --crafty-image IMAGE    Crafty image (default: arcadiatechnology/crafty-4:latest).
  --crafty-https-port P   Crafty panel HTTPS host port (default: 8443).
  --crafty-mc-port P      Minecraft Java host port (default: 25565).
  --crafty-bedrock-port P Minecraft Bedrock UDP host port (default: 19132).
  --crafty-bluemap-port P BlueMap host port (default: 8100).
  --crafty-squaremap-port P squaremap host port (default: 8110).
  --crafty-player-panel-port P Player Panel/Fabric host port (default: 8765).
  --server-id UUID        Fabric server UUID.
  --plugin-port PORT      Fabric API port.
  --web-port PORT         Panel host port (default: 8766).
  --bind ADDRESS          Published host address.
  --access-mode MODE      Web access: proxy, direct, custom, or ask.
  --web-container NAME    Web container name.
  --network NAME          Shared Docker network.
  --timezone ZONE         Override the detected host time zone.
  --public-url URL        Public HTTPS panel URL.
  --minecraft-auth-mode M Authentication mode: online, offline, or keep.
  --skip-fabric           Do not install the Fabric mod.
  --skip-web              Do not install the web component.
  --skip-maps             Do not detect, download, or configure BlueMap/squaremap.
  --skip-plugin-wait      Do not wait for the Minecraft server to start.
  --bluemap-accept-download
                          Accept BlueMap asset downloads in non-interactive mode.
  --force                 Back up and replace an existing installation.
  --help                  Show this help.

Non-interactive mode requires PLAYER_PANEL_ADMIN_PASSWORD.
EOF
}

while (($#)); do
  case "$1" in
    --non-interactive) PP_NON_INTERACTIVE=1 ;;
    --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --skip-fabric) SKIP_FABRIC=1 ;;
    --skip-web) SKIP_WEB=1 ;;
    --skip-maps) SKIP_MAPS=1 ;;
    --skip-plugin-wait) SKIP_PLUGIN_WAIT=1 ;;
    --bluemap-accept-download) BLUEMAP_ACCEPT_DOWNLOAD=true ;;
    --install-crafty) FORCE_CRAFTY_INSTALL=1 ;;
    --skip-crafty) SKIP_CRAFTY=1 ;;
    --config) CONFIG_FILE="${2:?Missing file}"; shift ;;
    --install-root) INSTALL_ROOT="${2:?Missing path}"; shift ;;
    --container) CRAFTY_CONTAINER="${2:?Missing name}"; shift ;;
    --crafty-root) CRAFTY_ROOT="${2:?Missing path}"; shift ;;
    --crafty-image) CRAFTY_IMAGE="${2:?Missing image}"; shift ;;
    --crafty-https-port) CRAFTY_HTTPS_PORT="${2:?Missing port}"; shift ;;
    --crafty-mc-port) CRAFTY_MC_PORT="${2:?Missing port}"; shift ;;
    --crafty-bedrock-port) CRAFTY_BEDROCK_PORT="${2:?Missing port}"; shift ;;
    --crafty-bluemap-port) CRAFTY_BLUEMAP_PORT="${2:?Missing port}"; shift ;;
    --crafty-squaremap-port) CRAFTY_SQUAREMAP_PORT="${2:?Missing port}"; shift ;;
    --crafty-player-panel-port) CRAFTY_PLAYER_PANEL_PORT="${2:?Missing port}"; shift ;;
    --server-id) SERVER_ID="${2:?Missing UUID}"; shift ;;
    --plugin-port) PLUGIN_PORT="${2:?Missing port}"; shift ;;
    --web-port) WEB_PORT="${2:?Missing port}"; shift ;;
    --bind) BIND_ADDRESS="${2:?Missing address}"; WEB_ACCESS_MODE=custom; shift ;;
    --access-mode) WEB_ACCESS_MODE="${2:?Missing mode}"; shift ;;
    --web-container) WEB_CONTAINER="${2:?Missing name}"; shift ;;
    --network) NETWORK="${2:?Missing name}"; shift ;;
    --timezone) TIMEZONE_NAME="${2:?Missing time zone}"; shift ;;
    --public-url) PUBLIC_URL="${2:?Missing URL}"; shift ;;
    --minecraft-auth-mode) MINECRAFT_AUTH_MODE="${2:?Missing mode}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done
export PP_NON_INTERACTIVE

load_config() {
  [[ -n "$CONFIG_FILE" ]] || return 0
  [[ -f "$CONFIG_FILE" ]] || pp_fail "Does not exist: $CONFIG_FILE"
  while IFS='=' read -r key value; do
    key="${key//[[:space:]]/}"
    [[ -n "$key" && "$key" != \#* ]] || continue
    value="${value%$'\r'}"
    case "$key" in
      INSTALL_ROOT) INSTALL_ROOT="$value" ;;
      CRAFTY_CONTAINER) CRAFTY_CONTAINER="$value" ;;
      CRAFTY_ROOT) CRAFTY_ROOT="$value" ;;
      CRAFTY_IMAGE) CRAFTY_IMAGE="$value" ;;
      CRAFTY_HTTPS_PORT) CRAFTY_HTTPS_PORT="$value" ;;
      CRAFTY_BLUEMAP_PORT) CRAFTY_BLUEMAP_PORT="$value" ;;
      CRAFTY_SQUAREMAP_PORT) CRAFTY_SQUAREMAP_PORT="$value" ;;
      CRAFTY_BEDROCK_PORT) CRAFTY_BEDROCK_PORT="$value" ;;
      CRAFTY_MC_PORT) CRAFTY_MC_PORT="$value" ;;
      CRAFTY_PLAYER_PANEL_PORT) CRAFTY_PLAYER_PANEL_PORT="$value" ;;
      SERVER_ID) SERVER_ID="$value" ;;
      PLUGIN_PORT) PLUGIN_PORT="$value" ;;
      WEB_PORT) WEB_PORT="$value" ;;
      BIND_ADDRESS) BIND_ADDRESS="$value" ;;
      WEB_ACCESS_MODE) WEB_ACCESS_MODE="$value" ;;
      WEB_CONTAINER) WEB_CONTAINER="$value" ;;
      NETWORK) NETWORK="$value" ;;
      TIMEZONE) TIMEZONE_NAME="$value" ;;
      PUBLIC_URL) PUBLIC_URL="$value" ;;
      MINECRAFT_AUTH_MODE) MINECRAFT_AUTH_MODE="$value" ;;
      VAPID_SUBJECT) VAPID_SUBJECT_VALUE="$value" ;;
      CRAFTY_PANEL_URL) CRAFTY_PANEL_URL_VALUE="$value" ;;
      CRAFTY_USERNAME) CRAFTY_USER_VALUE="$value" ;;
      SKIP_FABRIC) pp_is_true "$value" && SKIP_FABRIC=1 ;;
      SKIP_WEB) pp_is_true "$value" && SKIP_WEB=1 ;;
      SKIP_MAPS) pp_is_true "$value" && SKIP_MAPS=1 ;;
      SKIP_PLUGIN_WAIT) pp_is_true "$value" && SKIP_PLUGIN_WAIT=1 ;;
      BLUEMAP_ACCEPT_DOWNLOAD) BLUEMAP_ACCEPT_DOWNLOAD="$value" ;;
      SKIP_CRAFTY) pp_is_true "$value" && SKIP_CRAFTY=1 ;;
      INSTALL_CRAFTY) pp_is_true "$value" && FORCE_CRAFTY_INSTALL=1 ;;
      *) pp_warn "Ignored configuration key: $key" ;;
    esac
  done < "$CONFIG_FILE"
}
load_config

host_family() {
  [[ -r /etc/os-release ]] || pp_fail "Could not identify the operating system."
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) printf '%s' "$ID" ;;
    *) pp_fail "Automatic Docker installation supports Ubuntu and Debian. Detected system: ${ID:-unknown}." ;;
  esac
}

install_base_dependencies() {
  local missing=() cmd
  for cmd in curl openssl python3 sha256sum; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  ((${#missing[@]} == 0)) && return 0

  if [[ "$PP_NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
    pp_warn "Required tools are missing: ${missing[*]}"
    pp_confirm "Install the basic dependencies now?" yes || pp_fail "Required dependencies were not installed."
  fi

  command -v apt-get >/dev/null 2>&1 || pp_fail "apt-get was not found for dependency installation."
  pp_log "Installing basic dependencies..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl python3 coreutils
}

configure_docker_repository() {
  local family codename arch
  family="$(host_family)"
  # shellcheck disable=SC1091
  source /etc/os-release
  codename="${VERSION_CODENAME:-}"
  [[ -n "$codename" ]] || pp_fail "Could not determine VERSION_CODENAME."
  arch="$(dpkg --print-architecture)"

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$family/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$family
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
}

install_docker_engine() {
  if [[ "$PP_NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
    pp_confirm "Docker is not installed. Install Docker Engine and Docker Compose now?" yes || {
      pp_log "Installation cancelled: Docker is required to continue."
      exit 0
    }
  fi

  if [[ "$TEST_MODE" == 1 && -n "${PLAYER_PANEL_TEST_BIN:-}" ]]; then
    cp "$BUNDLE_DIR/tests/mock-docker" "$PLAYER_PANEL_TEST_BIN/docker"
    chmod +x "$PLAYER_PANEL_TEST_BIN/docker"
    DOCKER_INSTALLED_BY_SCRIPT=1
    pp_ok "Test: simulated Docker Engine and Docker Compose."
    return 0
  fi

  command -v apt-get >/dev/null 2>&1 || pp_fail "apt-get was not found for Docker installation."
  pp_log "Configuring the official Docker repository..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  DEBIAN_FRONTEND=noninteractive apt-get remove -y \
    docker.io docker-compose docker-compose-v2 podman-docker containerd runc 2>/dev/null || true
  configure_docker_repository
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  DOCKER_INSTALLED_BY_SCRIPT=1
  pp_ok "Docker Engine and Docker Compose installed."
}

ensure_docker_compose() {
  docker compose version >/dev/null 2>&1 && return 0

  if [[ "$PP_NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
    pp_confirm "Docker is installed, but Docker Compose v2 is missing. Install it now?" yes || pp_fail "Docker Compose v2 is required."
  fi

  configure_docker_repository
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  docker compose version >/dev/null 2>&1 || pp_fail "Docker Compose v2 is still unavailable."
  pp_ok "Docker Compose v2 installed."
}

ensure_docker_environment() {
  if ! command -v docker >/dev/null 2>&1; then
    install_docker_engine
  fi

  if ! docker version >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      pp_log "Docker is installed but not responding. Attempting to start the service..."
      systemctl enable --now docker || true
      sleep 3
    fi
  fi
  docker version >/dev/null 2>&1 || pp_fail "Docker is installed, but the daemon is not responding."
  ensure_docker_compose

  pp_ok "Docker available: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'detected version')"
  pp_ok "Docker Compose available: $(docker compose version --short 2>/dev/null || echo 'v2')"
}

preflight() {
  [[ -r "$BUNDLE_DIR/components/fabric/player-panel-1.1.7-fabric26.1.2.jar" || "$SKIP_FABRIC" == 1 ]] || pp_fail "Fabric JAR is missing."
  [[ -f "$BUNDLE_DIR/components/web/docker-compose.yml" || "$SKIP_WEB" == 1 ]] || pp_fail "Web component is missing."

  pp_validate_port "$WEB_PORT" || pp_fail "Invalid web port: $WEB_PORT"
  pp_validate_port "$CRAFTY_HTTPS_PORT" || pp_fail "Invalid Crafty HTTPS port: $CRAFTY_HTTPS_PORT"
  pp_validate_port "$CRAFTY_BLUEMAP_PORT" || pp_fail "Invalid BlueMap port: $CRAFTY_BLUEMAP_PORT"
  pp_validate_port "$CRAFTY_SQUAREMAP_PORT" || pp_fail "Invalid squaremap port: $CRAFTY_SQUAREMAP_PORT"
  pp_validate_port "$CRAFTY_BEDROCK_PORT" || pp_fail "Invalid Bedrock port: $CRAFTY_BEDROCK_PORT"
  pp_validate_port "$CRAFTY_MC_PORT" || pp_fail "Invalid Minecraft Java port: $CRAFTY_MC_PORT"
  pp_validate_port "$CRAFTY_PLAYER_PANEL_PORT" || pp_fail "Invalid Player Panel port: $CRAFTY_PLAYER_PANEL_PORT"
  [[ "$BIND_ADDRESS" =~ ^[0-9a-fA-F:.]+$ || "$BIND_ADDRESS" == localhost ]] || pp_fail "Invalid bind address: $BIND_ADDRESS"
  case "${WEB_ACCESS_MODE,,}" in
    ask|proxy|direct|custom) ;;
    *) pp_fail "Invalid web access mode: $WEB_ACCESS_MODE (use proxy, direct, or custom)." ;;
  esac
  case "${MINECRAFT_AUTH_MODE,,}" in
    ask|keep|online|offline) ;;
    *) pp_fail "Invalid authentication mode: $MINECRAFT_AUTH_MODE (use online, offline, or keep)." ;;
  esac
}

container_is_crafty() {
  local c="$1" image
  docker inspect "$c" >/dev/null 2>&1 || return 1
  image="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true)"
  [[ "$image" == *crafty* ]] || return 1
  return 0
}

find_crafty_containers() {
  local c
  while IFS= read -r c; do
    [[ -n "$c" ]] || continue
    container_is_crafty "$c" && printf '%s\n' "$c"
  done < <(docker ps -a --format '{{.Names}}')
}

crafty_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$CRAFTY_CONTAINER" 2>/dev/null || true)" == true ]]
}

ensure_crafty_running() {
  crafty_running && return 0
  pp_log "Starting Crafty container: $CRAFTY_CONTAINER"
  docker start "$CRAFTY_CONTAINER" >/dev/null
  local deadline=$((SECONDS+120))
  while ((SECONDS < deadline)); do
    docker exec "$CRAFTY_CONTAINER" test -d /crafty/servers >/dev/null 2>&1 && return 0
    sleep 3
  done
  pp_fail "Crafty was not available after starting the container."
}


discover_crafty_root() {
  local source_path actual_image
  source_path="$(docker inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/crafty/servers"}}{{.Source}}{{end}}{{end}}' \
    "$CRAFTY_CONTAINER" 2>/dev/null || true)"
  if [[ "$source_path" == */docker/servers ]]; then
    CRAFTY_ROOT="${source_path%/docker/servers}"
  fi
  actual_image="$(docker inspect -f '{{.Config.Image}}' "$CRAFTY_CONTAINER" 2>/dev/null || true)"
  [[ -z "$actual_image" ]] || CRAFTY_IMAGE="$actual_image"
}

validate_crafty_root() {
  [[ "$CRAFTY_ROOT" == /* ]] || pp_fail "CRAFTY_ROOT must be an absolute path."
  case "$CRAFTY_ROOT" in
    /|/root|/home|/opt|/srv|/var) pp_fail "Crafty path is too broad or unsafe: $CRAFTY_ROOT" ;;
  esac
}

write_crafty_compose() {
  cat > "$CRAFTY_ROOT/compose.yml" <<EOF
services:
  crafty:
    container_name: $CRAFTY_CONTAINER
    image: $CRAFTY_IMAGE
    restart: always
    environment:
      - TZ=$TIMEZONE_NAME
    ports:
      - "0.0.0.0:$CRAFTY_HTTPS_PORT:8443"
      - "0.0.0.0:$CRAFTY_MC_PORT:25565"
      - "0.0.0.0:$CRAFTY_BEDROCK_PORT:19132/udp"
      - "0.0.0.0:$CRAFTY_BLUEMAP_PORT:8100"
      - "0.0.0.0:$CRAFTY_PLAYER_PANEL_PORT:8765"
      - "0.0.0.0:$CRAFTY_SQUAREMAP_PORT:8110"
    volumes:
      - ./docker/backups:/crafty/backups
      - ./docker/config:/crafty/app/config
      - ./docker/import:/crafty/import
      - ./docker/servers:/crafty/servers
EOF
  chmod 600 "$CRAFTY_ROOT/compose.yml"
}

port_in_use() {
  local protocol="$1" port="$2"
  [[ "$TEST_MODE" == 0 ]] || return 1
  command -v ss >/dev/null 2>&1 || return 1
  if [[ "$protocol" == udp ]]; then
    ss -H -lun 2>/dev/null | awk '{print $5}' | grep -Eq "(^|:)$port$"
  else
    ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$"
  fi
}

resolve_host_port() {
  local var_name="$1" label="$2" protocol="$3" value
  value="${!var_name}"
  while port_in_use "$protocol" "$value"; do
    if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
      pp_fail "$label $value/$protocol is already in use."
    fi
    pp_warn "$label $value/$protocol is already in use."
    value="$(pp_prompt "New port for $label" "$value")"
    pp_validate_port "$value" || { pp_warn "Invalid port."; continue; }
  done
  printf -v "$var_name" '%s' "$value"
}

validate_unique_crafty_ports() {
  local ports=(
    "$CRAFTY_HTTPS_PORT" "$CRAFTY_MC_PORT" "$CRAFTY_BEDROCK_PORT"
    "$CRAFTY_BLUEMAP_PORT" "$CRAFTY_PLAYER_PANEL_PORT" "$CRAFTY_SQUAREMAP_PORT"
  )
  local seen=" " p
  for p in "${ports[@]}"; do
    [[ "$seen" != *" $p "* ]] || pp_fail "Duplicate ports in Crafty configuration: $p"
    seen+="$p "
  done
  [[ "$WEB_PORT" != "$CRAFTY_HTTPS_PORT" && "$WEB_PORT" != "$CRAFTY_MC_PORT" &&      "$WEB_PORT" != "$CRAFTY_BEDROCK_PORT" && "$WEB_PORT" != "$CRAFTY_BLUEMAP_PORT" &&      "$WEB_PORT" != "$CRAFTY_PLAYER_PANEL_PORT" && "$WEB_PORT" != "$CRAFTY_SQUAREMAP_PORT" ]]     || pp_fail "Player Panel web port ($WEB_PORT) matches a port published by Crafty."
}

configure_crafty_install_values() {
  if [[ "$PP_NON_INTERACTIVE" != 1 ]]; then
    CRAFTY_ROOT="$(pp_prompt 'Persistent Crafty path' "$CRAFTY_ROOT")"
    CRAFTY_HTTPS_PORT="$(pp_prompt 'Crafty HTTPS port' "$CRAFTY_HTTPS_PORT")"
  fi
  validate_crafty_root
  pp_validate_port "$CRAFTY_HTTPS_PORT" || pp_fail "Invalid Crafty HTTPS port."

  resolve_host_port CRAFTY_HTTPS_PORT "Crafty HTTPS" tcp
  resolve_host_port CRAFTY_MC_PORT "Minecraft Java" tcp
  resolve_host_port CRAFTY_BEDROCK_PORT "Minecraft Bedrock" udp
  resolve_host_port CRAFTY_BLUEMAP_PORT "BlueMap" tcp
  resolve_host_port CRAFTY_PLAYER_PANEL_PORT "Player Panel" tcp
  resolve_host_port CRAFTY_SQUAREMAP_PORT "squaremap" tcp
  validate_unique_crafty_ports
}

wait_crafty_https() {
  if [[ "$TEST_MODE" == 1 ]]; then
    pp_ok "Test: simulated Crafty is available."
    return 0
  fi
  local deadline=$((SECONDS+240)) code
  while ((SECONDS < deadline)); do
    code="$(curl -ksS -o /dev/null -w '%{http_code}' "https://127.0.0.1:$CRAFTY_HTTPS_PORT/" 2>/dev/null || true)"
    case "$code" in
      200|302|303) pp_ok "Crafty responds over HTTPS on port $CRAFTY_HTTPS_PORT."; return 0 ;;
    esac
    sleep 4
  done
  docker logs --tail 80 "$CRAFTY_CONTAINER" 2>/dev/null || true
  pp_fail "Crafty did not respond over HTTPS within 240 seconds."
}

wait_default_credentials() {
  local creds="$CRAFTY_ROOT/docker/config/default-creds.txt"
  if [[ "$TEST_MODE" == 1 ]]; then
    mkdir -p "$(dirname "$creds")"
    printf 'username: admin\npassword: test-only\n' > "$creds"
    chmod 600 "$creds"
    return 0
  fi
  local deadline=$((SECONDS+180))
  while ((SECONDS < deadline)); do
    [[ -s "$creds" ]] && { chmod 600 "$creds" 2>/dev/null || true; return 0; }
    sleep 3
  done
  pp_warn "default-creds.txt did not appear. Review the Crafty logs."
  return 0
}

crafty_root_has_only_incomplete_scaffold() {
  [[ -d "$CRAFTY_ROOT/docker" ]] || return 1
  [[ ! -e "$CRAFTY_ROOT/docker/config/default-creds.txt" ]] || return 1
  [[ -z "$(find "$CRAFTY_ROOT/docker" -type f -print -quit 2>/dev/null)" ]] || return 1
  return 0
}

show_docker_storage_diagnostics() {
  pp_warn "Docker storage summary:"
  docker system df 2>/dev/null || true
  df -h / /var/lib/docker 2>/dev/null || true
  df -ih / /var/lib/docker 2>/dev/null || true
  docker info 2>/dev/null | grep -E 'Server Version|Storage Driver|driver-type|Docker Root Dir|Architecture' || true
}

pull_crafty_image() {
  pp_log "Downloading the Crafty image with standard Docker progress: $CRAFTY_IMAGE"
  echo
  if docker pull "$CRAFTY_IMAGE"; then
    echo
    pp_ok "Crafty image downloaded successfully."
    return 0
  fi

  echo
  pp_warn "Docker could not download or extract the Crafty image."
  pp_warn "Existing images, containers, and volumes will not be deleted."
  show_docker_storage_diagnostics
  pp_fail "Could not download or extract $CRAFTY_IMAGE. Review Docker, the network, and storage before retrying."
}

show_default_credentials() {
  local creds="$CRAFTY_ROOT/docker/config/default-creds.txt"

  echo
  echo "============================================================"
  echo "Initial Crafty credentials"
  echo "============================================================"

  if [[ -s "$creds" ]]; then
    chmod 600 "$creds" 2>/dev/null || true
    cat -- "$creds"
  else
    echo "[WARNING] The credentials file is not available yet."
  fi

  echo "============================================================"
  echo "File: $creds"
  echo
}

load_default_crafty_credentials() {
  local creds="$CRAFTY_ROOT/docker/config/default-creds.txt" username password
  [[ "$CRAFTY_INSTALLED_BY_SCRIPT" == 1 ]] || return 0
  [[ -s "$creds" ]] || return 0
  [[ -z "$CRAFTY_USER_VALUE" && -z "$CRAFTY_TOKEN_VALUE" ]] || return 0

  username="$(awk -F: 'tolower($1) ~ /^[[:space:]]*user(name)?[[:space:]]*$/ {sub(/^[^:]*:[[:space:]]*/, ""); print; exit}' "$creds" | tr -d '\r')"
  password="$(awk -F: 'tolower($1) ~ /^[[:space:]]*password[[:space:]]*$/ {sub(/^[^:]*:[[:space:]]*/, ""); print; exit}' "$creds" | tr -d '\r')"
  username="${username#\"}"; username="${username%\"}"
  password="${password#\"}"; password="${password%\"}"

  if [[ -n "$username" && -n "$password" ]]; then
    CRAFTY_USER_VALUE="$username"
    CRAFTY_PASSWORD_VALUE="$password"
    pp_ok "The initial Crafty credentials will be linked automatically to Player Panel."
  else
    pp_warn "The initial Crafty credentials could not be parsed; configure them under System > Crafty Installations."
  fi
}

install_crafty() {
  get_timezone
  configure_crafty_install_values

  if docker inspect "$CRAFTY_CONTAINER" >/dev/null 2>&1; then
    pp_fail "A container already exists with the name $CRAFTY_CONTAINER."
  fi
  if [[ -e "$CRAFTY_ROOT" && -n "$(find "$CRAFTY_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    if crafty_root_has_only_incomplete_scaffold; then
      pp_warn "An incomplete empty Crafty installation was detected. It will be cleaned for a fresh retry."
      rm -rf -- "$CRAFTY_ROOT"
    elif [[ "$FORCE" == 1 ]]; then
      local old="${CRAFTY_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"
      pp_warn "Moving the existing Crafty path to $old"
      mv "$CRAFTY_ROOT" "$old"
    elif [[ "$PP_NON_INTERACTIVE" != 1 ]] && pp_confirm "The path $CRAFTY_ROOT contains data. Back it up and continue?" no; then
      local old="${CRAFTY_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"
      mv "$CRAFTY_ROOT" "$old"
      pp_ok "Ruta anterior respaldada en $old"
    else
      pp_fail "The path $CRAFTY_ROOT is not empty."
    fi
  fi

  pp_log "Preparing a fresh Crafty installation at $CRAFTY_ROOT"
  mkdir -p "$CRAFTY_ROOT/docker"/{backups,servers,config,import}
  chmod 2775 "$CRAFTY_ROOT/docker" "$CRAFTY_ROOT/docker"/{backups,servers,config,import}
  write_crafty_compose
  (cd "$CRAFTY_ROOT" && docker compose -f compose.yml config >/dev/null)

  echo
  echo "Crafty configuration:"
  echo "  Image:          $CRAFTY_IMAGE"
  echo "  Data:           $CRAFTY_ROOT/docker"
  echo "  HTTPS:           $CRAFTY_HTTPS_PORT -> 8443"
  echo "  Minecraft Java: $CRAFTY_MC_PORT -> 25565"
  echo "  Bedrock UDP:    $CRAFTY_BEDROCK_PORT -> 19132"
  echo "  BlueMap:        $CRAFTY_BLUEMAP_PORT -> 8100"
  echo "  Player Panel:   $CRAFTY_PLAYER_PANEL_PORT -> 8765"
  echo "  squaremap:      $CRAFTY_SQUAREMAP_PORT -> 8110"
  echo
  if [[ "$PP_NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
    pp_confirm "Start the Crafty installation with this configuration?" yes || {
      pp_log "Installation cancelled without starting Crafty."
      exit 0
    }
  fi

  pull_crafty_image
  if ! (cd "$CRAFTY_ROOT" && docker compose -f compose.yml up -d); then
    docker logs --tail 100 "$CRAFTY_CONTAINER" 2>/dev/null || true
    pp_fail "Docker Compose could not start Crafty. Review ports and logs."
  fi
  CRAFTY_INSTALLED_BY_SCRIPT=1
  wait_crafty_https
  wait_default_credentials
  load_default_crafty_credentials
  pp_ok "Crafty installed from scratch."
  pp_open_tcp_port "$CRAFTY_HTTPS_PORT" "Crafty"

  if [[ "$PP_NON_INTERACTIVE" != 1 ]]; then
    show_default_credentials
    echo "Crafty access: $(crafty_access_url)"
    echo
    echo "Open Crafty, sign in with the displayed credentials, and create a Minecraft Java server with Fabric $MC_VERSION."
    read -r -p "When the Fabric server appears in the panel, press Enter to continue... " _
  else
    pp_log "Initial Crafty credentials: $CRAFTY_ROOT/docker/config/default-creds.txt"
  fi
}

choose_or_install_crafty() {
  local choices=() i
  mapfile -t choices < <(find_crafty_containers)

  if [[ "$FORCE_CRAFTY_INSTALL" == 1 ]]; then
    ((${#choices[@]} == 0)) || pp_fail "A Crafty container already exists. Run without --install-crafty to use it."
    install_crafty
    return
  fi

  if ((${#choices[@]} == 0)); then
    if [[ "$SKIP_CRAFTY" == 1 ]]; then
      pp_log "Crafty was not detected and installation was disabled. No changes were made."
      exit 0
    fi
    if [[ "$PP_NON_INTERACTIVE" == 1 || "$ASSUME_YES" == 1 ]]; then
      install_crafty
    elif pp_confirm "Crafty was not detected. Install it now?" yes; then
      install_crafty
    else
      pp_log "Installation cancelled: this full workflow requires a Crafty-managed server."
      exit 0
    fi
    return
  fi

  if [[ -n "$CRAFTY_CONTAINER" ]] && container_is_crafty "$CRAFTY_CONTAINER"; then
    if [[ "$PP_NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
      pp_confirm "Crafty was detected in '$CRAFTY_CONTAINER'. Use this container?" yes || {
        pp_log "Installation cancelled without modifying Crafty."
        exit 0
      }
    fi
    ensure_crafty_running
    discover_crafty_root
    return
  fi

  if ((${#choices[@]} == 1)); then
    CRAFTY_CONTAINER="${choices[0]}"
    if [[ "$PP_NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
      pp_confirm "Crafty was detected in '$CRAFTY_CONTAINER'. Use this container?" yes || {
        pp_log "Installation cancelled without modifying Crafty."
        exit 0
      }
    fi
    ensure_crafty_running
    discover_crafty_root
    return
  fi

  [[ "$PP_NON_INTERACTIVE" == 0 ]] || pp_fail "Multiple Crafty containers were detected; use --container."
  echo "Detected Crafty containers:"
  for i in "${!choices[@]}"; do printf '  [%d] %s\n' "$((i+1))" "${choices[$i]}"; done
  while true; do
    read -r -p "Select the container: " i
    [[ "$i" =~ ^[0-9]+$ ]] && ((i>=1 && i<=${#choices[@]})) || continue
    CRAFTY_CONTAINER="${choices[$((i-1))]}"
    break
  done
  ensure_crafty_running
  discover_crafty_root
}

server_rows() {
  docker exec -i "$CRAFTY_CONTAINER" python3 - < "$BUNDLE_DIR/scripts/lib/crafty-server-discovery.py"
}

confirm_fabric_server() {
  case "$SELECTED_KIND" in
    Fabric)
      return 0
      ;;
    Unknown)
      if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
        if [[ -n "$SERVER_ID" ]]; then
          pp_warn "Crafty has not reported the server type for $SERVER_ID. Because the UUID was provided explicitly, it will continue as Fabric."
          SELECTED_KIND="Fabric"
          return 0
        fi
        pp_fail "The selected server could not be confirmed automatically as Fabric. Use --server-id after verifying it in Crafty."
      fi
      pp_warn "Crafty has not reported the type of '$SELECTED_NAME'. This can happen immediately after server creation, before the mods directory or Fabric launcher appears."
      if pp_confirm "Confirm that '$SELECTED_NAME' was created as Fabric $MC_VERSION and continue?" yes; then
        SELECTED_KIND="Fabric"
        return 0
      fi
      return 1
      ;;
    *)
      pp_warn "The selected server was detected as '$SELECTED_KIND'. This public release installs Fabric only."
      return 1
      ;;
  esac
}

choose_server() {
  mapfile -t rows < <(server_rows)
  while ((${#rows[@]} == 0)); do
    if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
      pp_fail "No servers were found. Create a Fabric server in Crafty or use an existing installation."
    fi
    pp_warn "Crafty has no servers yet."
    echo "Open $(crafty_access_url) and create a Minecraft Java server with Fabric $MC_VERSION."
    read -r -p "When creation is complete, press Enter to detect again... " _
    mapfile -t rows < <(server_rows)
  done

  if [[ -n "$SERVER_ID" ]]; then
    local row sid name kind running found=0
    for row in "${rows[@]}"; do
      IFS=$'\t' read -r sid name kind running <<<"$row"
      if [[ "$sid" == "$SERVER_ID" ]]; then
        SELECTED_NAME="$name"; SELECTED_KIND="$kind"; SELECTED_RUNNING="$running"; found=1; break
      fi
    done
    ((found)) || pp_fail "UUID $SERVER_ID does not exist in $CRAFTY_CONTAINER."
    confirm_fabric_server || pp_fail "The selected server was not confirmed as Fabric."
  else
    if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
      local fabric_count=0 row sid name kind running unknown_count=0 unknown_sid=''
      for row in "${rows[@]}"; do
        IFS=$'\t' read -r sid name kind running <<<"$row"
        if [[ "$kind" == Fabric ]]; then
          SERVER_ID="$sid"; SELECTED_NAME="$name"; SELECTED_KIND="$kind"; SELECTED_RUNNING="$running"; ((fabric_count+=1))
        elif [[ "$kind" == Unknown ]]; then
          unknown_sid="$sid"; ((unknown_count+=1))
        fi
      done
      if ((fabric_count == 0 && unknown_count == 1)); then
        pp_fail "The only detected server still appears as Unknown. Run again with --server-id $unknown_sid after confirming in Crafty that it is Fabric."
      fi
      ((fabric_count == 1)) || pp_fail "Use --server-id; there are $fabric_count detected Fabric servers."
    else
      while true; do
        mapfile -t rows < <(server_rows)
        echo "Detected servers:"
        local i row sid name kind running state
        for i in "${!rows[@]}"; do
          IFS=$'\t' read -r sid name kind running <<<"${rows[$i]}"
          state=$([[ "$running" == 1 ]] && echo "Running" || echo "Stopped")
          printf '  [%d] %s | %s | %s\n      UUID: %s\n' "$((i+1))" "$name" "$kind" "$state" "$sid"
        done
        read -r -p "Select the Fabric server (or R to detect again): " i
        if [[ "$i" =~ ^[Rr]$ ]]; then
          continue
        fi
        [[ "$i" =~ ^[0-9]+$ ]] && ((i>=1 && i<=${#rows[@]})) || {
          pp_warn "Invalid selection."
          continue
        }
        IFS=$'\t' read -r SERVER_ID SELECTED_NAME SELECTED_KIND SELECTED_RUNNING <<<"${rows[$((i-1))]}"
        confirm_fabric_server || continue
        break
      done
    fi
  fi

  [[ "$SELECTED_KIND" == Fabric ]] || pp_fail "No compatible Fabric server was confirmed."
}

selected_server_running() {
  server_rows | awk -F '\t' -v id="$SERVER_ID" '$1==id {print $4; exit}' | grep -qx 1
}

ensure_server_stopped() {
  selected_server_running || return 0
  if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
    pp_fail "Server $SELECTED_NAME is running. Stop it from Crafty."
  fi
  pp_warn "The server must be stopped before installing the JAR."
  while selected_server_running; do
    read -r -p "Stop '$SELECTED_NAME' from Crafty and press Enter to check... " _
  done
  pp_ok "Server stopped."
}


current_minecraft_auth_mode() {
  if [[ "$TEST_MODE" == 1 ]]; then
    printf '%s' online
    return 0
  fi
  local root="/crafty/servers/$SERVER_ID"
  docker exec -i "$CRAFTY_CONTAINER" python3 - "$root/server.properties" <<'PYMODE'
from pathlib import Path
import sys
path = Path(sys.argv[1])
value = 'true'
if path.is_file():
    for raw in path.read_text('utf-8', errors='replace').splitlines():
        line = raw.strip()
        if line and not line.startswith('#') and '=' in line:
            key, item = line.split('=', 1)
            if key.strip() == 'online-mode':
                value = item.strip().lower()
                break
print('offline' if value in {'false', '0', 'no', 'off'} else 'online')
PYMODE
}

configure_minecraft_auth_mode() {
  local current requested choice output
  current="$(current_minecraft_auth_mode | tr -d '\r\n')"
  [[ "$current" == online || "$current" == offline ]] || current=online
  requested="${MINECRAFT_AUTH_MODE,,}"

  if [[ "$requested" == ask ]]; then
    if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
      requested=keep
    else
      echo
      echo "Current Minecraft authentication mode: $current"
      echo "  [1] Online  - official accounts authenticated by Microsoft/Mojang only."
      echo "  [2] Offline - allows launchers without an official session; the whitelist uses offline UUIDs."
      echo "  [3] Keep the current mode."
      while true; do
        read -r -p "Select the mode [3]: " choice
        choice="${choice:-3}"
        case "$choice" in
          1) requested=online; break ;;
          2) requested=offline; break ;;
          3) requested=keep; break ;;
          *) pp_warn "Select 1, 2, or 3." ;;
        esac
      done
    fi
  fi

  [[ "$requested" != keep ]] || requested="$current"
  MINECRAFT_AUTH_MODE_RESOLVED="$requested"

  if [[ "$requested" == offline ]]; then
    pp_warn "Offline mode does not validate name ownership. Keep the whitelist enabled and match the player name capitalization exactly."
    if [[ "$current" == online ]]; then
      pp_warn "Switching from online to offline changes UUIDs. The installer repairs whitelist, operators, bans, and profile cache; it does not move existing world playerdata."
    fi
  fi

  if [[ "$TEST_MODE" == 1 ]]; then
    MINECRAFT_AUTH_MODE_CHANGED=$([[ "$current" == "$requested" ]] && echo 0 || echo 1)
    [[ "$requested" == offline ]] && OFFLINE_IDENTITIES_REPAIRED=1
    pp_ok "Test: Minecraft mode $requested simulated."
    return 0
  fi

  local root="/crafty/servers/$SERVER_ID"
  output="$(docker exec -i "$CRAFTY_CONTAINER" python3 - "$root" "$requested" <<'PYAUTH'
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
mode = sys.argv[2].strip().lower()
if mode not in {'online', 'offline'}:
    raise SystemExit(f'INVALID_MODE={mode}')

properties = root / 'server.properties'
if not properties.is_file():
    raise SystemExit(f'MISSING_SERVER_PROPERTIES={properties}')

raw_text = properties.read_text('utf-8', errors='replace')
lines = raw_text.splitlines()
props: dict[str, str] = {}
for raw in lines:
    stripped = raw.strip()
    if stripped and not stripped.startswith('#') and '=' in raw:
        key, value = raw.split('=', 1)
        props[key.strip()] = value.strip()

current = 'offline' if props.get('online-mode', 'true').lower() in {'false', '0', 'no', 'off'} else 'online'
required = {
    'online-mode': 'true' if mode == 'online' else 'false',
    'white-list': 'true',
    'enforce-whitelist': 'true',
}
if mode == 'offline':
    required['enforce-secure-profile'] = 'false'

changed = any(props.get(key, '').lower() != value for key, value in required.items())
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = root / 'player-panel-backups' / f'auth-mode-{stamp}'
backup.mkdir(parents=True, exist_ok=True)

for candidate in ('server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'usercache.json'):
    source = root / candidate
    if source.is_file():
        shutil.copy2(source, backup / candidate)

seen: set[str] = set()
new_lines: list[str] = []
for raw in lines:
    stripped = raw.strip()
    if stripped and not stripped.startswith('#') and '=' in raw:
        key = raw.split('=', 1)[0].strip()
        if key in required:
            new_lines.append(f'{key}={required[key]}')
            seen.add(key)
            continue
    new_lines.append(raw)
for key, value in required.items():
    if key not in seen:
        new_lines.append(f'{key}={value}')
properties.write_text('\n'.join(new_lines).rstrip() + '\n', 'utf-8')


def offline_uuid(name: str) -> str:
    digest = bytearray(hashlib.md5(('OfflinePlayer:' + name).encode('utf-8')).digest())
    digest[6] = (digest[6] & 0x0F) | 0x30
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))

# Use the most recent capitalization observed in failed connection attempts.
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
            re.compile(r"Disconnecting ([A-Za-z0-9_]{3,16}) \\([^)]*\\): Failed to verify username!"),
        )
        for line in text.splitlines():
            for pattern in patterns:
                match = pattern.search(line)
                if match:
                    name = match.group(1)
                    observed[name.lower()] = name
    except OSError:
        pass

repaired = 0
renamed = 0
if mode == 'offline':
    identity_files = ('whitelist.json', 'ops.json', 'banned-players.json', 'usercache.json')
    for filename in identity_files:
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
                renamed += 1
                dirty = True
            if str(item.get('uuid') or '').lower() != expected:
                item['uuid'] = expected
                repaired += 1
                dirty = True
        if dirty:
            path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', 'utf-8')

print(f'CURRENT={current}')
print(f'RESOLVED={mode}')
print(f'CHANGED={1 if changed or current != mode else 0}')
print(f'REPAIRED={repaired}')
print(f'RENAMED={renamed}')
print(f'BACKUP={backup}')
PYAUTH
)"

  MINECRAFT_AUTH_MODE_CHANGED="$(awk -F= '$1=="CHANGED"{print $2; exit}' <<<"$output")"
  local repaired renamed backup
  repaired="$(awk -F= '$1=="REPAIRED"{print $2; exit}' <<<"$output")"
  renamed="$(awk -F= '$1=="RENAMED"{print $2; exit}' <<<"$output")"
  backup="$(awk -F= '$1=="BACKUP"{sub(/^BACKUP=/,""); print; exit}' <<<"$output")"
  [[ "${repaired:-0}" =~ ^[0-9]+$ ]] || repaired=0
  [[ "${renamed:-0}" =~ ^[0-9]+$ ]] || renamed=0
  if [[ "$requested" == offline ]]; then
    OFFLINE_IDENTITIES_REPAIRED=1
    pp_ok "Offline identities reviewed: $repaired UUIDs corrected; $renamed names adjusted for capitalization."
  fi
  docker exec "$CRAFTY_CONTAINER" sh -lc "set -eu; chown crafty:root '$root/server.properties' 2>/dev/null || true; chmod 0644 '$root/server.properties'; for f in '$root'/whitelist.json '$root'/ops.json '$root'/banned-players.json '$root'/usercache.json; do [ -f \"\$f\" ] || continue; chown crafty:root \"\$f\" 2>/dev/null || true; chmod 0644 \"\$f\"; done"
  pp_ok "Minecraft mode configured: $requested. Backup: $backup"
}

repair_bluemap_permissions() {
  [[ "$SKIP_MAPS" == 0 ]] || return 0
  [[ "$TEST_MODE" == 0 ]] || return 0
  local root="/crafty/servers/$SERVER_ID"
  docker exec "$CRAFTY_CONTAINER" sh -lc "
    set -eu
    for path in '$root/config/bluemap' '$root/bluemap'; do
      [ -e \"\$path\" ] || continue
      chown -R crafty:root \"\$path\" 2>/dev/null || true
      find \"\$path\" -type d -exec chmod 0775 {} + 2>/dev/null || true
      find \"\$path\" -type f -exec chmod 0664 {} + 2>/dev/null || true
    done
  "
  pp_ok "BlueMap permissions normalized for the Crafty user."
}

choose_plugin_port() {
  local existing
  existing="$(docker exec "$CRAFTY_CONTAINER" sh -lc "awk -F= '/^api.port=/{gsub(/[[:space:]]/,\"\",\$2); print \$2; exit}' '/crafty/servers/$SERVER_ID/config/player-panel-fabric.properties' 2>/dev/null || true" | tr -d '\r')"
  if [[ -z "$PLUGIN_PORT" ]]; then
    if [[ -n "$existing" ]]; then
      PLUGIN_PORT="$existing"
    else
      mapfile -t used < <(docker exec "$CRAFTY_CONTAINER" sh -lc 'for f in /crafty/servers/*/config/player-panel-fabric.properties; do [ -f "$f" ] || continue; awk -F= '\''/^api.port=/{gsub(/[[:space:]]/,"",$2); print $2; exit}'\'' "$f"; done' | sed '/^$/d')
      local candidate found p
      for candidate in $(seq 8765 8799); do
        found=0
        for p in "${used[@]:-}"; do [[ "$p" == "$candidate" ]] && found=1; done
        ((found)) || { PLUGIN_PORT="$candidate"; break; }
      done
    fi
  fi
  pp_validate_port "$PLUGIN_PORT" || pp_fail "Invalid plugin port: $PLUGIN_PORT"
  if [[ "$PP_NON_INTERACTIVE" != 1 ]]; then
    PLUGIN_PORT="$(pp_prompt 'Internal Fabric API port' "$PLUGIN_PORT")"
    pp_validate_port "$PLUGIN_PORT" || pp_fail "Invalid port."
  fi
}

ensure_fabric_api() {
  local server_root="$1" info version path source
  if [[ "$TEST_MODE" == 1 ]]; then
    FABRIC_API_DETECTED_VERSION="$FABRIC_API_VERSION"
    pp_ok "Test: Fabric API $FABRIC_API_VERSION simulated."
    return 0
  fi

  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" fabric-api || true)"
  if [[ -n "$info" ]]; then
    IFS=$'\t' read -r _ version path source <<<"$info"
    if [[ -n "$version" ]] && pp_version_at_least "$version" "$FABRIC_API_MIN_VERSION"; then
      FABRIC_API_DETECTED_VERSION="$version"
      pp_ok "Compatible Fabric API detected: $version ($path)."
      return 0
    fi
    if [[ -z "$version" ]]; then
      pp_warn "A file that appears to be Fabric API was found, but its version could not be validated: $path"
    else
      pp_warn "Fabric API $version is older than the required minimum $FABRIC_API_MIN_VERSION."
    fi
    if [[ "$ASSUME_YES" != 1 ]] && ! pp_confirm "Download and install Fabric API $FABRIC_API_VERSION compatible with Minecraft $MC_VERSION?" yes; then
      pp_fail "Player Panel requires Fabric API $FABRIC_API_MIN_VERSION or later. Without it, the server cannot start."
    fi
  else
    pp_warn "Fabric API was not detected in $server_root/mods."
    if [[ "$ASSUME_YES" != 1 ]] && ! pp_confirm "Download and install Fabric API $FABRIC_API_VERSION now?" yes; then
      pp_fail "Player Panel requires Fabric API $FABRIC_API_MIN_VERSION or later. Without it, the server cannot start."
    fi
  fi

  pp_install_fabric_mod "$CRAFTY_CONTAINER" "$server_root" \
    "Fabric API" fabric-api "$FABRIC_API_VERSION" "$FABRIC_API_FILE" "$FABRIC_API_URL" "$FABRIC_API_SHA256"
  FABRIC_API_DETECTED_VERSION="$FABRIC_API_VERSION"
}

refresh_detected_mod_versions() {
  [[ "$TEST_MODE" == 0 ]] || return 0
  local server_root="/crafty/servers/$SERVER_ID" info version path source

  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" fabric-api || true)"
  if [[ -n "$info" ]]; then
    IFS=$'\t' read -r _ version path source <<<"$info"
    FABRIC_API_DETECTED_VERSION="${version:-unknown}"
  fi

  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" squaremap || true)"
  if [[ -n "$info" ]]; then
    IFS=$'\t' read -r _ version path source <<<"$info"
    SQUAREMAP_DETECTED_VERSION="${version:-unknown}"
  fi

  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" bluemap || true)"
  if [[ -n "$info" ]]; then
    IFS=$'\t' read -r _ version path source <<<"$info"
    BLUEMAP_DETECTED_VERSION="${version:-unknown}"
  fi
}

offer_optional_map_mods() {
  local server_root="$1" info version path source
  [[ "$SKIP_MAPS" == 0 ]] || return 0
  [[ "$TEST_MODE" == 0 ]] || return 0

  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" squaremap || true)"
  if [[ -n "$info" ]]; then
    IFS=$'\t' read -r _ version path source <<<"$info"
    SQUAREMAP_DETECTED_VERSION="${version:-unknown}"
    pp_ok "squaremap detected: ${version:-version not reported} ($path)."
  else
    if [[ "$ASSUME_YES" == 1 ]] || pp_confirm "squaremap was not detected. Download and install squaremap $SQUAREMAP_VERSION for Minecraft $MC_VERSION?" no; then
      pp_install_fabric_mod "$CRAFTY_CONTAINER" "$server_root" \
        "squaremap" squaremap "$SQUAREMAP_VERSION" "$SQUAREMAP_FILE" "$SQUAREMAP_URL" "$SQUAREMAP_SHA256"
      SQUAREMAP_DETECTED_VERSION="$SQUAREMAP_VERSION"
      SQUAREMAP_INSTALLED_BY_SCRIPT=1
    else
      pp_log "squaremap will not be installed."
    fi
  fi

  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$server_root" bluemap || true)"
  if [[ -n "$info" ]]; then
    IFS=$'\t' read -r _ version path source <<<"$info"
    BLUEMAP_DETECTED_VERSION="${version:-unknown}"
    pp_ok "BlueMap detected: ${version:-version not reported} ($path)."
  else
    if [[ "$ASSUME_YES" == 1 ]] || pp_confirm "BlueMap was not detected. Download and install BlueMap $BLUEMAP_VERSION Fabric for Minecraft $MC_VERSION?" no; then
      pp_install_fabric_mod "$CRAFTY_CONTAINER" "$server_root" \
        "BlueMap" bluemap "$BLUEMAP_VERSION" "$BLUEMAP_FILE" "$BLUEMAP_URL"
      BLUEMAP_DETECTED_VERSION="$BLUEMAP_VERSION"
      BLUEMAP_INSTALLED_BY_SCRIPT=1
    else
      pp_log "BlueMap will not be installed."
    fi
  fi
}

install_fabric() {
  [[ "$SKIP_FABRIC" == 0 ]] || return 0
  ensure_server_stopped
  choose_plugin_port
  local server_root="/crafty/servers/$SERVER_ID"
  local jar="$BUNDLE_DIR/components/fabric/player-panel-1.1.7-fabric26.1.2.jar"
  local stamp backup tmp token
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="$server_root/player-panel-backups/pre-clean-install-$stamp"
  tmp="$(mktemp -d)"

  pp_log "Preparing Fabric server directories"
  docker exec "$CRAFTY_CONTAINER" sh -lc "set -eu; test -d '$server_root'; mkdir -p '$server_root/mods' '$server_root/config' '$server_root/player-panel-backups'; chown crafty:root '$server_root/mods' '$server_root/config' '$server_root/player-panel-backups' 2>/dev/null || true"

  ensure_fabric_api "$server_root"
  offer_optional_map_mods "$server_root"

  pp_log "Creating backup at $backup"
  docker exec "$CRAFTY_CONTAINER" sh -lc "set -eu; mkdir -p '$backup'; for f in '$server_root'/mods/player-panel-*.jar; do [ -f \"\$f\" ] && cp -a \"\$f\" '$backup/' || true; done; [ -f '$server_root/config/player-panel-fabric.properties' ] && cp -a '$server_root/config/player-panel-fabric.properties' '$backup/' || true"

  if docker exec "$CRAFTY_CONTAINER" test -f "$server_root/config/player-panel-fabric.properties"; then
    docker cp "$CRAFTY_CONTAINER:$server_root/config/player-panel-fabric.properties" "$tmp/player-panel-fabric.properties"
  else
    : > "$tmp/player-panel-fabric.properties"
  fi
  token="$(openssl rand -hex 32)"
  PP_TOKEN="$token" PP_PORT="$PLUGIN_PORT" python3 - "$tmp/player-panel-fabric.properties" <<'PYCFG'
from pathlib import Path
import os, sys
path = Path(sys.argv[1])
props = {}
for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
    line = raw.strip()
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=',1)
        props[key.strip()] = value.strip()
token = props.get('security.token','')
if len(token) < 32:
    token = os.environ['PP_TOKEN']
props.update({
    'api.enabled':'true', 'api.bind-address':'0.0.0.0', 'api.port':os.environ['PP_PORT'],
    'api.worker-threads':props.get('api.worker-threads','4'),
    'api.max-request-size-bytes':props.get('api.max-request-size-bytes','65536'),
    'security.require-token':'true', 'security.token':token,
    'security.rate-limit.enabled':props.get('security.rate-limit.enabled','true'),
    'security.rate-limit.requests-per-minute':props.get('security.rate-limit.requests-per-minute','120'),
})
order = ['api.enabled','api.bind-address','api.port','api.worker-threads','api.max-request-size-bytes','security.require-token','security.token','security.rate-limit.enabled','security.rate-limit.requests-per-minute']
path.write_text('# Player Panel Fabric configuration\n' + '\n'.join(f'{k}={props[k]}' for k in order) + '\n', encoding='utf-8')
PYCFG
  token="$(awk -F= '/^security.token=/{print $2; exit}' "$tmp/player-panel-fabric.properties")"
  [[ ${#token} -ge 32 ]] || pp_fail "A valid token was not generated."

  docker cp "$jar" "$CRAFTY_CONTAINER:$server_root/mods/player-panel-1.1.7-fabric26.1.2.jar"
  docker cp "$tmp/player-panel-fabric.properties" "$CRAFTY_CONTAINER:$server_root/config/player-panel-fabric.properties"
  docker exec "$CRAFTY_CONTAINER" sh -lc "set -eu; test -s '$server_root/mods/player-panel-1.1.7-fabric26.1.2.jar'; test -s '$server_root/config/player-panel-fabric.properties'; for f in '$server_root'/mods/player-panel-*.jar; do [ -f \"\$f\" ] || continue; [ \"\$f\" = '$server_root/mods/player-panel-1.1.7-fabric26.1.2.jar' ] || rm -f \"\$f\"; done; chown crafty:root '$server_root/mods/player-panel-1.1.7-fabric26.1.2.jar' '$server_root/config/player-panel-fabric.properties' 2>/dev/null || true; chmod 0644 '$server_root/mods/player-panel-1.1.7-fabric26.1.2.jar'; chmod 0600 '$server_root/config/player-panel-fabric.properties'"

  PLUGIN_TOKEN="$token"
  rm -rf "$tmp"
  unset token PP_TOKEN
  pp_ok "Fabric mod and configuration installed."
}

read_plugin_config() {
  local server_root="/crafty/servers/$SERVER_ID" tmp
  tmp="$(mktemp)"
  docker cp "$CRAFTY_CONTAINER:$server_root/config/player-panel-fabric.properties" "$tmp" >/dev/null
  PLUGIN_PORT="${PLUGIN_PORT:-$(awk -F= '/^api.port=/{print $2; exit}' "$tmp")}" 
  PLUGIN_TOKEN="$(awk -F= '/^security.token=/{print $2; exit}' "$tmp")"
  [[ ${#PLUGIN_TOKEN} -ge 32 ]] || pp_fail "The Fabric token is invalid."
  rm -f "$tmp"
}

wait_plugin() {
  [[ "$SKIP_PLUGIN_WAIT" == 0 ]] || { pp_warn "Plugin wait was skipped."; return 0; }
  if [[ "$TEST_MODE" == 1 ]]; then pp_ok "Test: simulated plugin is available."; return 0; fi
  if [[ "$PP_NON_INTERACTIVE" != 1 ]]; then
    echo
    echo "Start '$SELECTED_NAME' from Crafty. The installer will wait for the Fabric API."
    read -r -p "Press Enter after starting the server... " _
  fi
  local deadline=$((SECONDS+240))
  while ((SECONDS < deadline)); do
    if docker exec -i "$CRAFTY_CONTAINER" python3 - "$PLUGIN_PORT" "$PLUGIN_TOKEN" >/dev/null 2>&1 <<'PYHEALTH'
import json, sys, urllib.request
port, token = sys.argv[1], sys.argv[2]
req = urllib.request.Request(f'http://127.0.0.1:{port}/api/v1/health', headers={'Authorization':f'Bearer {token}'})
with urllib.request.urlopen(req, timeout=2) as r:
    data=json.load(r)
    assert r.status == 200 and data.get('success') is True
PYHEALTH
    then
      pp_ok "Fabric API available on port $PLUGIN_PORT."
      return 0
    fi
    sleep 4
  done
  pp_warn "The Fabric API did not respond within 240 seconds. The web app will be installed but remain disconnected until the server starts correctly."
}

timezone_is_valid() {
  local zone="${1:-}"
  [[ -n "$zone" && "$zone" != *".."* && "$zone" != /* ]] || return 1
  [[ "$zone" == "UTC" || -e "/usr/share/zoneinfo/$zone" ]]
}

detect_host_timezone() {
  local zone="" localtime_target=""

  if command -v timedatectl >/dev/null 2>&1; then
    zone="$(timedatectl show --property=Timezone --value 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    timezone_is_valid "$zone" && { printf '%s' "$zone"; return 0; }
  fi

  if [[ -r /etc/timezone ]]; then
    zone="$(head -n 1 /etc/timezone 2>/dev/null | tr -d '\r' | xargs || true)"
    timezone_is_valid "$zone" && { printf '%s' "$zone"; return 0; }
  fi

  localtime_target="$(readlink -f /etc/localtime 2>/dev/null || true)"
  case "$localtime_target" in
    /usr/share/zoneinfo/*)
      zone="${localtime_target#/usr/share/zoneinfo/}"
      zone="${zone#posix/}"
      zone="${zone#right/}"
      timezone_is_valid "$zone" && { printf '%s' "$zone"; return 0; }
      ;;
  esac

  printf 'UTC'
}

get_timezone() {
  [[ "$TIMEZONE_RESOLVED" == 0 ]] || return 0

  if [[ -n "$TIMEZONE_NAME" ]]; then
    TIMEZONE_ORIGIN="explicit configuration"
    timezone_is_valid "$TIMEZONE_NAME" || pp_fail "Invalid IANA time zone: $TIMEZONE_NAME"
  else
    TIMEZONE_NAME="$(detect_host_timezone)"
    TIMEZONE_ORIGIN="host"
    if ! timezone_is_valid "$TIMEZONE_NAME"; then
      pp_warn "A valid time zone could not be detected; UTC will be used."
      TIMEZONE_NAME="UTC"
    fi
  fi

  TIMEZONE_RESOLVED=1
  if [[ "$TIMEZONE_ORIGIN" == "host" ]]; then
    pp_ok "Host time zone detected: $TIMEZONE_NAME"
  else
    pp_ok "Time zone configured explicitly: $TIMEZONE_NAME"
  fi
}

bind_is_loopback() {
  [[ "$1" == 127.* || "$1" == "::1" || "$1" == "localhost" ]]
}

resolve_host_ipv4() {
  [[ -n "$HOST_IPV4" ]] || HOST_IPV4="$(pp_detect_host_ipv4)"
  printf '%s' "$HOST_IPV4"
}

crafty_access_url() {
  printf 'https://%s:%s' "$(resolve_host_ipv4)" "$CRAFTY_HTTPS_PORT"
}

player_panel_access_url() {
  printf 'http://%s:%s' "$(resolve_host_ipv4)" "$WEB_PORT"
}

resolve_web_access_mode() {
  local mode="${WEB_ACCESS_MODE,,}"

  # Normal installation publishes on all interfaces without prompting.
  # Proxy/custom modes remain available for explicit advanced CLI/config use.
  [[ "$mode" != ask ]] || mode=direct

  case "$mode" in
    direct)
      BIND_ADDRESS=0.0.0.0
      pp_log "Player Panel will be published automatically on all interfaces: $(player_panel_access_url)"
      ;;
    proxy)
      BIND_ADDRESS=127.0.0.1
      ;;
    custom)
      [[ -n "$BIND_ADDRESS" ]] || pp_fail "Custom mode requires a listen address."
      ;;
    *) pp_fail "Invalid web access mode: $mode" ;;
  esac

  WEB_ACCESS_MODE_RESOLVED="$mode"
}

configure_web_values() {
  get_timezone
  if [[ "$PP_NON_INTERACTIVE" != 1 ]]; then
    WEB_PORT="$(pp_prompt 'Web panel port' "$WEB_PORT")"
  fi
  resolve_web_access_mode
  if [[ "$PP_NON_INTERACTIVE" != 1 ]]; then
    PUBLIC_URL="$(pp_prompt 'Public HTTPS URL (blank if not available yet)' "$PUBLIC_URL")"
    CRAFTY_PANEL_URL_VALUE="$(pp_prompt 'Public Crafty URL (optional)' "$CRAFTY_PANEL_URL_VALUE")"
  fi
  pp_validate_port "$WEB_PORT" || pp_fail "Invalid web port."
  if [[ -z "$VAPID_SUBJECT_VALUE" ]]; then
    if [[ "$PUBLIC_URL" == https://* ]]; then VAPID_SUBJECT_VALUE="$PUBLIC_URL"; else VAPID_SUBJECT_VALUE="mailto:admin@example.com"; fi
  fi

  ADMIN_PASSWORD_VALUE="$(pp_read_secret_twice 'Initial admin user password')"
  [[ ${#ADMIN_PASSWORD_VALUE} -ge 10 ]] || pp_fail "The password must contain at least 10 characters."

  if [[ "$PP_NON_INTERACTIVE" != 1 && -z "$CRAFTY_USER_VALUE" && -z "$CRAFTY_TOKEN_VALUE" ]]; then
    if pp_confirm "Configure a limited Crafty API user now?" yes; then
      CRAFTY_USER_VALUE="$(pp_prompt 'Crafty API username' '')"
      [[ -n "$CRAFTY_USER_VALUE" ]] || pp_fail "The username cannot be empty."
      CRAFTY_PASSWORD_VALUE="$(pp_read_secret_once 'Crafty API password')"
      [[ -n "$CRAFTY_PASSWORD_VALUE" ]] || pp_fail "The Crafty password cannot be empty."
    fi
  fi
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

install_web() {
  [[ "$SKIP_WEB" == 0 ]] || return 0
  configure_web_values
  if [[ -e "$INSTALL_ROOT" ]]; then
    if [[ "$FORCE" == 1 ]]; then
      local backup="${INSTALL_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"
      pp_warn "Moving the existing installation to $backup"
      mv "$INSTALL_ROOT" "$backup"
    elif [[ "$PP_NON_INTERACTIVE" != 1 ]] && pp_confirm "Already exists: $INSTALL_ROOT. Back it up and replace it?" no; then
      local backup="${INSTALL_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"
      mv "$INSTALL_ROOT" "$backup"
      pp_ok "Previous installation backed up to $backup"
    else
      pp_fail "Already exists: $INSTALL_ROOT."
    fi
  fi
  mkdir -p "$INSTALL_ROOT"
  cp -a "$BUNDLE_DIR/components/web/." "$INSTALL_ROOT/"
  mkdir -p "$INSTALL_ROOT/secrets" "$INSTALL_ROOT/data"
  chmod 700 "$INSTALL_ROOT/secrets" "$INSTALL_ROOT/data"

  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
  local secure=false trust=false trusted_proxy_cidrs
  trusted_proxy_cidrs="$(trusted_proxy_cidrs_for_network "$NETWORK")"
  if [[ "$PUBLIC_URL" == https://* ]]; then secure=true; fi
  if [[ "$WEB_ACCESS_MODE_RESOLVED" == direct ]]; then secure=false; fi
  if [[ "$WEB_ACCESS_MODE_RESOLVED" == proxy || "$PUBLIC_URL" == https://* || "$BIND_ADDRESS" == 127.* || "$BIND_ADDRESS" == "::1" || "$BIND_ADDRESS" == "localhost" ]]; then
    trust=true
  fi
  if [[ "$WEB_ACCESS_MODE_RESOLVED" == direct ]]; then trust=true; fi
  cat > "$INSTALL_ROOT/.env" <<EOF
PLAYER_PANEL_CONTAINER_NAME=$WEB_CONTAINER
PLAYER_PANEL_NETWORK=$NETWORK
PLAYER_PANEL_BIND_ADDRESS=$BIND_ADDRESS
PLAYER_PANEL_WEB_ACCESS_MODE=$WEB_ACCESS_MODE_RESOLVED
PLAYER_PANEL_WEB_PORT=$WEB_PORT
PLAYER_PANEL_API_URL=http://$CRAFTY_CONTAINER:$PLUGIN_PORT
CRAFTY_API_URL=https://$CRAFTY_CONTAINER:8443
CRAFTY_SERVER_ID=$SERVER_ID
CRAFTY_PANEL_URL=$CRAFTY_PANEL_URL_VALUE
CRAFTY_VERIFY_TLS=false
TZ=$TIMEZONE_NAME
VAPID_SUBJECT=$VAPID_SUBJECT_VALUE
COOKIE_SECURE=$secure
TRUST_PROXY=$trust
TRUSTED_PROXY_CIDRS=$trusted_proxy_cidrs
MINECRAFT_ASSET_VERSION=$MC_VERSION
MINECRAFT_AUTH_MODE=$MINECRAFT_AUTH_MODE_RESOLVED
EOF
  chmod 600 "$INSTALL_ROOT/.env"

  printf '%s' "$PLUGIN_TOKEN" > "$INSTALL_ROOT/secrets/player_panel_api_token.txt"
  printf '%s' "$ADMIN_PASSWORD_VALUE" > "$INSTALL_ROOT/secrets/admin_password.txt"
  openssl rand -hex 32 > "$INSTALL_ROOT/secrets/session_secret.txt"
  printf '%s' "$CRAFTY_USER_VALUE" > "$INSTALL_ROOT/secrets/crafty_username.txt"
  printf '%s' "$CRAFTY_PASSWORD_VALUE" > "$INSTALL_ROOT/secrets/crafty_password.txt"
  printf '%s' "$CRAFTY_TOKEN_VALUE" > "$INSTALL_ROOT/secrets/crafty_api_token.txt"
  chmod 600 "$INSTALL_ROOT/secrets"/*.txt
  unset ADMIN_PASSWORD_VALUE CRAFTY_PASSWORD_VALUE CRAFTY_TOKEN_VALUE

  local networks
  networks="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$CRAFTY_CONTAINER")"
  grep -q '"'"$NETWORK"'"' <<<"$networks" || docker network connect "$NETWORK" "$CRAFTY_CONTAINER"

  (cd "$INSTALL_ROOT" && docker compose --env-file .env build)
  local image uid gid
  image="$(cd "$INSTALL_ROOT" && docker compose --env-file .env config --images | head -n1)"
  uid="$(docker run --rm --entrypoint sh "$image" -c 'id -u playerpanel')"
  gid="$(docker run --rm --entrypoint sh "$image" -c 'id -g playerpanel')"
  chown "$uid:$gid" "$INSTALL_ROOT/secrets"/*.txt
  chown -R "$uid:$gid" "$INSTALL_ROOT/data"
  chmod 600 "$INSTALL_ROOT/secrets"/*.txt
  chmod 700 "$INSTALL_ROOT/secrets" "$INSTALL_ROOT/data"
  (cd "$INSTALL_ROOT" && docker compose --env-file .env up -d)
  pp_ok "Web component deployed."
}

web_health() {
  [[ "$SKIP_WEB" == 0 ]] || return 0
  if [[ "$TEST_MODE" == 1 ]]; then pp_ok "Test: simulated web health for $WEB_VERSION."; return 0; fi
  local deadline=$((SECONDS+120))
  while ((SECONDS < deadline)); do
    if curl -fsS "http://127.0.0.1:$WEB_PORT/healthz" | grep -q '"version":"1.10.19"'; then
      pp_ok "Web $WEB_VERSION healthy."
      return 0
    fi
    sleep 3
  done
  pp_fail "The web app did not respond correctly at http://127.0.0.1:$WEB_PORT/healthz"
}

bluemap_core_config() {
  local root="$1"
  docker exec "$CRAFTY_CONTAINER" sh -lc "
    for f in \
      '$root/config/bluemap/core.conf' \
      '$root/plugins/BlueMap/core.conf' \
      '$root/bluemap/core.conf'
    do
      if [ -f \"\$f\" ]; then printf '%s\\n' \"\$f\"; exit 0; fi
    done
    find '$root' -maxdepth 5 -type f -path '*/bluemap/core.conf' -print -quit 2>/dev/null || true
  " | tr -d '\r'
}

configure_bluemap_assets() {
  local root="$1" info core current stamp
  info="$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$root" bluemap || true)"
  [[ -n "$info" ]] || return 0

  local wait_seconds=90
  [[ "$SKIP_PLUGIN_WAIT" == 1 ]] && wait_seconds=0
  local deadline=$((SECONDS + wait_seconds))
  core="$(bluemap_core_config "$root")"
  while [[ -z "$core" && $SECONDS -lt $deadline ]]; do
    sleep 3
    core="$(bluemap_core_config "$root")"
  done
  if [[ -z "$core" ]]; then
    pp_warn "BlueMap is installed, but core.conf did not appear after the first start. Start or restart the server and review its log."
    return 0
  fi

  current="$(docker exec -i "$CRAFTY_CONTAINER" python3 - "$core" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text('utf-8', errors='replace')
m = re.search(r'(?im)^\s*accept-download\s*:\s*(true|false)\b', text)
print(m.group(1).lower() if m else 'missing')
PY
)"
  if [[ "$current" == true ]]; then
    BLUEMAP_ASSETS_ACCEPTED=1
    pp_ok "BlueMap already has accept-download: true in $core."
    return 0
  fi

  echo
  echo "BlueMap needs official Minecraft client resources to render textures."
  echo "By accepting, you confirm that you own a Minecraft Java license and allow"
  echo "BlueMap to download those resources from official Mojang/Microsoft servers."

  if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
    if ! pp_is_true "$BLUEMAP_ACCEPT_DOWNLOAD"; then
      pp_warn "BlueMap asset download was not enabled. Use BLUEMAP_ACCEPT_DOWNLOAD=true or --bluemap-accept-download in non-interactive mode."
      return 0
    fi
  else
    if ! pp_confirm "Allow downloading the assets required by BlueMap?" no; then
      pp_warn "BlueMap was installed, but it will not download assets or render until accept-download is set to true."
      return 0
    fi
  fi

  stamp="$(date +%Y%m%d-%H%M%S)"
  docker exec "$CRAFTY_CONTAINER" cp -p "$core" "$core.pre-player-panel-$stamp"
  docker exec -i "$CRAFTY_CONTAINER" python3 - "$core" <<'PY'
import re, sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text('utf-8', errors='replace')
pattern = re.compile(r'(?im)^(\s*accept-download\s*:\s*)(true|false)(\b.*)$')
if pattern.search(text):
    text = pattern.sub(r'\1true\3', text, count=1)
else:
    text = 'accept-download: true\n' + text
path.write_text(text, 'utf-8')
print('BLUEMAP_ASSETS_ACCEPTED')
PY
  BLUEMAP_ASSETS_ACCEPTED=1
  MAP_RESTART_REQUIRED=1
  pp_ok "BlueMap is authorized to download its assets on the next restart."
}

maps_install() {
  [[ "$SKIP_MAPS" == 0 ]] || return 0
  [[ "$TEST_MODE" == 0 ]] || { pp_log "Test: maps skipped."; return 0; }
  local root="/crafty/servers/$SERVER_ID"
  local has_blue=0 has_square=0
  docker exec "$CRAFTY_CONTAINER" sh -lc "test -f '$root/config/bluemap/webapp.conf' || test -f '$root/plugins/BlueMap/webapp.conf'" >/dev/null 2>&1 && has_blue=1
  docker exec "$CRAFTY_CONTAINER" sh -lc "test -f '$root/squaremap/config.yml' || test -f '$root/config/squaremap/config.yml' || test -f '$root/plugins/squaremap/config.yml'" >/dev/null 2>&1 && has_square=1

  configure_bluemap_assets "$root"

  if ((has_blue)); then
    if [[ "$ASSUME_YES" == 1 ]] || pp_confirm "BlueMap detected. Install its Player Panel selection bridge?" yes; then
      "$BUNDLE_DIR/scripts/maps/install-bluemap-bridge.sh" "$CRAFTY_CONTAINER" "$SERVER_ID"
      MAP_RESTART_REQUIRED=1
    fi
  elif [[ -n "$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$root" bluemap || true)" ]]; then
    pp_warn "BlueMap is installed but did not generate webapp.conf; the bridge could not be installed."
  fi

  if ((has_square)); then
    if [[ "$ASSUME_YES" == 1 ]] || pp_confirm "squaremap detected. Configure port $CRAFTY_SQUAREMAP_PORT and install its selection bridge?" yes; then
      "$BUNDLE_DIR/scripts/maps/configure-squaremap.sh" "$CRAFTY_CONTAINER" "$SERVER_ID" "$CRAFTY_SQUAREMAP_PORT"
      "$BUNDLE_DIR/scripts/maps/install-squaremap-bridge.sh" "$CRAFTY_CONTAINER" "$SERVER_ID"
      MAP_RESTART_REQUIRED=1
    fi
  elif [[ -n "$(pp_fabric_mod_info "$CRAFTY_CONTAINER" "$root" squaremap || true)" ]]; then
    pp_warn "squaremap is installed but did not generate config.yml; it could not be configured and the bridge could not be installed."
  fi

  if ((!has_blue && !has_square)); then
    pp_log "No generated BlueMap or squaremap configurations were detected."
  fi
}

prompt_map_restart() {
  [[ "$MAP_RESTART_REQUIRED" == 1 ]] || return 0
  echo
  pp_warn "Map configuration changed and requires a Minecraft server restart."
  if [[ "$PP_NON_INTERACTIVE" == 1 ]]; then
    pp_warn "Restart '$SELECTED_NAME' from Crafty. If assets were accepted, BlueMap will download them during startup."
    return 0
  fi
  echo "Restart '$SELECTED_NAME' from Crafty."
  [[ "$BLUEMAP_ASSETS_ACCEPTED" == 1 ]] && echo "During startup, BlueMap will download and prepare the required official assets."
  read -r -p "After the server restarts, press Enter to continue... " _
}

write_report() {
  local report="$INSTALL_ROOT/install-report.txt"
  [[ "$SKIP_WEB" == 0 ]] || report="$BUNDLE_DIR/install-report.txt"
  cat > "$report" <<EOF
Player Panel clean install report
Generated: $(date -Is)
Bundle: $BUNDLE_VERSION
Web: $WEB_VERSION
Fabric: $FABRIC_VERSION
Fabric API: ${FABRIC_API_DETECTED_VERSION:-not detected}
Minecraft: $MC_VERSION
Minecraft auth mode: ${MINECRAFT_AUTH_MODE_RESOLVED:-not configured}
Offline identities repaired: $OFFLINE_IDENTITIES_REPAIRED
Squaremap: ${SQUAREMAP_DETECTED_VERSION:-not installed}
BlueMap: ${BLUEMAP_DETECTED_VERSION:-not installed}
BlueMap assets accepted: $BLUEMAP_ASSETS_ACCEPTED
Docker installed by this run: $DOCKER_INSTALLED_BY_SCRIPT
Crafty container: $CRAFTY_CONTAINER
Crafty installed by this run: $CRAFTY_INSTALLED_BY_SCRIPT
Crafty root: $CRAFTY_ROOT
Crafty image: $CRAFTY_IMAGE
Detected host IPv4: $(resolve_host_ipv4)
Crafty HTTPS host port: $CRAFTY_HTTPS_PORT
Crafty URL: $(crafty_access_url)
Server name: $SELECTED_NAME
Server UUID: $SERVER_ID
Plugin port: $PLUGIN_PORT
Web container: $WEB_CONTAINER
Web access mode: ${WEB_ACCESS_MODE_RESOLVED:-custom}
Web bind: $BIND_ADDRESS:$WEB_PORT
Web URL: $(player_panel_access_url)
Install root: $INSTALL_ROOT
Timezone: $TIMEZONE_NAME
Public URL: ${PUBLIC_URL:-not configured}
Secrets: REDACTED
EOF
  chmod 600 "$report"
  pp_ok "Report saved to $report"
}

summary() {
  echo
  echo "============================================================"
  echo "Player Panel $BUNDLE_VERSION installed"
  echo "============================================================"
  echo "Crafty: $(crafty_access_url)"
  [[ "$CRAFTY_INSTALLED_BY_SCRIPT" == 1 ]] && echo "Crafty data: $CRAFTY_ROOT"
  echo "Server: $SELECTED_NAME ($SERVER_ID)"
  echo "Minecraft authentication: ${MINECRAFT_AUTH_MODE_RESOLVED:-unchanged}"
  echo "API Fabric: http://$CRAFTY_CONTAINER:$PLUGIN_PORT"
  if [[ "$SKIP_WEB" == 0 ]]; then
    if bind_is_loopback "$BIND_ADDRESS"; then
      echo "Local panel (server only): http://127.0.0.1:$WEB_PORT"
      [[ -n "$PUBLIC_URL" ]] && echo "Public panel: $PUBLIC_URL"
      if [[ -z "$PUBLIC_URL" ]]; then
        echo "[WARNING] The panel cannot be opened through $(resolve_host_ipv4):$WEB_PORT while listening on 127.0.0.1."
        echo "Configure an HTTPS proxy or run configure-web-access.sh --mode direct."
      fi
    else
      echo "Player Panel: $(player_panel_access_url)"
      [[ -n "$PUBLIC_URL" ]] && echo "Configured public panel: $PUBLIC_URL"
      echo "[WARNING] If it does not open from another device, allow TCP/$WEB_PORT in the VPS/provider firewall."
    fi
    echo "Initial user: admin"
    echo "Path: $INSTALL_ROOT"
  fi
  echo
  echo "Tokens and passwords are not shown in this summary."
  echo "Post-install validation: $BUNDLE_DIR/validate.sh --install-root '$INSTALL_ROOT' --container '$CRAFTY_CONTAINER' --server-id '$SERVER_ID'"
}

main() {
  echo "Player Panel — guided installation $BUNDLE_VERSION"
  install_base_dependencies
  ensure_docker_environment
  preflight
  HOST_IPV4="$(pp_detect_host_ipv4)"
  pp_ok "Primary host IP detected: $HOST_IPV4"
  get_timezone
  choose_or_install_crafty
  choose_server
  pp_log "Crafty: $CRAFTY_CONTAINER"
  pp_log "Server: $SELECTED_NAME ($SERVER_ID)"
  if [[ "$ASSUME_YES" != 1 && "$PP_NON_INTERACTIVE" != 1 ]]; then pp_confirm "Continue with the clean installation?" yes || exit 0; fi
  ensure_server_stopped
  configure_minecraft_auth_mode
  if [[ "$SKIP_FABRIC" == 0 ]]; then install_fabric; else choose_plugin_port; read_plugin_config; fi
  wait_plugin
  refresh_detected_mod_versions
  maps_install
  repair_bluemap_permissions
  prompt_map_restart
  install_web
  web_health
  pp_open_tcp_port "$WEB_PORT" "Player Panel"
  write_report
  summary
}

main "$@"
