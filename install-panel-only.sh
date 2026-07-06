#!/usr/bin/env bash

# Installs Player Panel Web only. It does not install or modify Crafty,
# Minecraft servers, Fabric, mods, maps, whitelist, or server.properties.

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

BUNDLE_VERSION="1.0.0-beta.1"
WEB_VERSION="1.10.19"
INSTALL_ROOT="${PLAYER_PANEL_INSTALL_ROOT:-/opt/player-panel}"
WEB_PORT="${PLAYER_PANEL_WEB_PORT:-8766}"
BIND_ADDRESS="${PLAYER_PANEL_BIND_ADDRESS:-0.0.0.0}"
WEB_CONTAINER="${PLAYER_PANEL_CONTAINER_NAME:-player-panel-web}"
NETWORK="${PLAYER_PANEL_NETWORK:-player-panel-net}"
PLUGIN_URL="${PLAYER_PANEL_API_URL:-}"
CRAFTY_URL="${CRAFTY_API_URL:-}"
CRAFTY_PANEL_URL_VALUE="${CRAFTY_PANEL_URL:-}"
SQUAREMAP_URL="${PLAYER_PANEL_SQUAREMAP_URL:-}"
SQUAREMAP_WORLD_ID="${PLAYER_PANEL_SQUAREMAP_WORLD_ID:-minecraft:overworld}"
TIMEZONE_NAME="${PLAYER_PANEL_TIMEZONE:-}"
PUBLIC_URL="${PLAYER_PANEL_PUBLIC_URL:-}"
VAPID_SUBJECT_VALUE="${VAPID_SUBJECT:-mailto:admin@example.com}"
MINECRAFT_ASSET_VERSION_VALUE="${MINECRAFT_ASSET_VERSION:-26.1.2}"
MINECRAFT_AUTH_MODE_VALUE="${MINECRAFT_AUTH_MODE:-online}"
SETUP_MODE="${PLAYER_PANEL_SETUP_MODE:-}"
ASSUME_YES=0
NON_INTERACTIVE=0
FORCE=0
NO_CACHE=0
SKIP_DOCKER_INSTALL=0
TEST_MODE="${PLAYER_PANEL_TEST_MODE:-0}"

usage() {
  cat <<'USAGE'
Usage:
  ./install-panel-only.sh [options]

Installs Player Panel Web only. It does not install or modify Crafty, Minecraft,
Fabric, mods, BlueMap, squaremap, whitelist, or server.properties.

Options:
  --install-root PATH     Installation path (default: /opt/player-panel)
  --web-port PORT       Panel HTTP port (default: 8766)
  --bind DIRECCION        Listen address (default: 0.0.0.0)
  --web-container NAME  Container name (default: player-panel-web)
  --network NAME        Panel Docker network (default: player-panel-net)
  --setup-mode MODO       Initial workflow: manual, crafty, or later
  --plugin-url ADDRESS  Initial plugin API IP, host, or URL
  --squaremap-url URL     Optional public squaremap URL for manual mode
  --squaremap-world ID    squaremap world (default: minecraft:overworld)
  --crafty-url ADDRESS  Initial Crafty IP, host, or URL
  --public-url URL        Optional public panel URL
  --timezone ZONA         IANA time zone, for example America/Panama
  --no-cache              Rebuild the Docker image without cache
  --skip-docker-install   Do not attempt to install Docker when missing
  --force                 Back up and replace an existing installation
  --non-interactive       Do not prompt for input
  --yes                   Accept safe confirmations
  -h, --help              Show this help

Useful variables for non-interactive mode:
  PLAYER_PANEL_ADMIN_PASSWORD  Required
  PLAYER_PANEL_SETUP_MODE      manual, crafty, or later
  PLAYER_PANEL_API_TOKEN       Optional initial plugin token
  PLAYER_PANEL_SQUAREMAP_URL   Optional public squaremap URL
  PLAYER_PANEL_SQUAREMAP_WORLD_ID  squaremap world
  CRAFTY_USERNAME              Optional initial Crafty username
  CRAFTY_PASSWORD              Optional initial Crafty password
  CRAFTY_API_TOKEN             Optional initial Crafty token
USAGE
}

while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:?Missing path}"; shift ;;
    --web-port) WEB_PORT="${2:?Missing port}"; shift ;;
    --bind) BIND_ADDRESS="${2:?Missing address}"; shift ;;
    --web-container) WEB_CONTAINER="${2:?Missing name}"; shift ;;
    --network) NETWORK="${2:?Missing name}"; shift ;;
    --setup-mode) SETUP_MODE="${2:?Missing mode}"; shift ;;
    --plugin-url) PLUGIN_URL="${2:?Missing URL}"; shift ;;
    --squaremap-url) SQUAREMAP_URL="${2:?Missing URL}"; shift ;;
    --squaremap-world) SQUAREMAP_WORLD_ID="${2:?Missing world}"; shift ;;
    --crafty-url) CRAFTY_URL="${2:?Missing URL}"; shift ;;
    --public-url) PUBLIC_URL="${2:?Missing URL}"; shift ;;
    --timezone) TIMEZONE_NAME="${2:?Missing time zone}"; shift ;;
    --no-cache) NO_CACHE=1 ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1 ;;
    --force) FORCE=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) pp_fail "Unknown option: $1" ;;
  esac
  shift
done
export PP_NON_INTERACTIVE="$NON_INTERACTIVE"

validate_url() {
  [[ -n "$1" && ! "$1" =~ [[:space:]] ]]
}

normalize_service_address() {
  local raw="${1:-}" kind="${2:-plugin}" authority host scheme port
  raw="${raw%/}"
  [[ -n "$raw" ]] || { printf '%s' ""; return 0; }
  if [[ "$raw" =~ ^https?:// ]]; then
    printf '%s' "$raw"
    return 0
  fi
  authority="${raw%%/*}"
  host="$authority"
  if [[ "$host" == \[*\]* ]]; then
    host="${host#\[}"; host="${host%%\]*}"
  elif [[ "$host" == *:* && "$host" != *:*:* ]]; then
    host="${host%%:*}"
  fi
  case "$kind" in
    plugin) scheme="http"; port="8765" ;;
    crafty|crafty-public) scheme="https"; port="8443" ;;
    bluemap|squaremap) scheme="http"; port="" ;;
    *) scheme="https"; port="" ;;
  esac
  # Public domain names default to HTTPS and do not receive an internal port.
  if [[ "$host" == *.* && ! "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && "$host" != *.local && "$host" != *.internal && "$host" != *.lan ]]; then
    scheme="https"
    port=""
  fi
  if [[ -n "$port" && "$authority" != *:* ]]; then
    raw="${authority}:${port}${raw#"$authority"}"
  fi
  printf '%s://%s' "$scheme" "$raw"
}

configure_docker_repository() {
  local os_id family codename arch
  # shellcheck disable=SC1091
  source /etc/os-release
  os_id="${ID:-}"
  case "$os_id" in
    ubuntu|debian) family="$os_id" ;;
    *) pp_fail "Automatic Docker installation is supported only on Ubuntu/Debian. Install Docker manually or use --skip-docker-install." ;;
  esac
  codename="${VERSION_CODENAME:-}"
  [[ -n "$codename" ]] || pp_fail "Could not determine VERSION_CODENAME."
  arch="$(dpkg --print-architecture)"

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$family/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<DOCKER_REPO
Types: deb
URIs: https://download.docker.com/linux/$family
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER_REPO
}

install_docker_engine() {
  [[ "$SKIP_DOCKER_INSTALL" == 0 ]] || pp_fail "Docker is not installed and --skip-docker-install was specified."
  if [[ "$NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
    pp_confirm "Docker is not installed. Install Docker Engine and Docker Compose now?" yes || exit 0
  fi
  command -v apt-get >/dev/null 2>&1 || pp_fail "apt-get was not found for Docker installation."
  pp_log "Installing Docker Engine and Docker Compose..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  configure_docker_repository
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    install_docker_engine
  fi
  if ! docker version >/dev/null 2>&1; then
    command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker || true
    sleep 2
  fi
  docker version >/dev/null 2>&1 || pp_fail "The Docker daemon is not responding."

  if ! docker compose version >/dev/null 2>&1; then
    [[ "$SKIP_DOCKER_INSTALL" == 0 ]] || pp_fail "Docker Compose v2 is missing."
    command -v apt-get >/dev/null 2>&1 || pp_fail "Docker Compose v2 is missing."
    configure_docker_repository
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  fi
  docker compose version >/dev/null 2>&1 || pp_fail "Docker Compose v2 is unavailable."
  pp_ok "Docker and Docker Compose are available."
}

detect_timezone() {
  if [[ -n "$TIMEZONE_NAME" ]]; then
    return 0
  fi
  if [[ -f /etc/timezone ]]; then
    TIMEZONE_NAME="$(tr -d '[:space:]' </etc/timezone)"
  fi
  if [[ -z "$TIMEZONE_NAME" ]] && command -v timedatectl >/dev/null 2>&1; then
    TIMEZONE_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
  TIMEZONE_NAME="${TIMEZONE_NAME:-UTC}"
}

trusted_proxy_cidrs() {
  local subnet=""
  subnet="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NETWORK" 2>/dev/null || true)"
  if [[ -n "$subnet" ]]; then
    printf '127.0.0.0/8,::1/128,%s' "$subnet"
  else
    printf '127.0.0.0/8,::1/128'
  fi
}

choose_setup_mode() {
  SETUP_MODE="${SETUP_MODE,,}"
  if [[ -z "$SETUP_MODE" ]]; then
    if [[ "$NON_INTERACTIVE" == 1 ]]; then
      SETUP_MODE="later"
    else
      echo
      echo "How do you want to connect Player Panel?"
      echo "  [1] Direct plugin connection (without Crafty)"
      echo "  [2] Import and manage through Crafty"
      echo "  [3] Configure later from the web UI"
      local choice
      choice="$(pp_prompt 'Select an option' '3')"
      case "$choice" in
        1|manual) SETUP_MODE="manual" ;;
        2|crafty) SETUP_MODE="crafty" ;;
        3|later|later|later|'') SETUP_MODE="later" ;;
        *) pp_fail "Invalid initial setup option: $choice" ;;
      esac
    fi
  fi
  case "$SETUP_MODE" in
    manual|crafty|later) ;;
    *) pp_fail "--setup-mode must be manual, crafty, or later." ;;
  esac

  if [[ "$SETUP_MODE" == "manual" ]]; then
    CRAFTY_URL=""
    if [[ "$NON_INTERACTIVE" != 1 ]]; then
      PLUGIN_URL="$(pp_prompt 'Plugin API address (IP, host, or URL)' "$PLUGIN_URL")"
      if [[ -z "${PLAYER_PANEL_API_TOKEN:-}" ]]; then
        PLAYER_PANEL_API_TOKEN="$(pp_read_secret_once 'Plugin token (press Enter to configure it later in the web UI)')"
      fi
      SQUAREMAP_URL="$(pp_prompt 'squaremap address (IP, host, or URL; press Enter to skip)' "$SQUAREMAP_URL")"
      if [[ -n "$SQUAREMAP_URL" ]]; then
        SQUAREMAP_WORLD_ID="$(pp_prompt 'squaremap world' "$SQUAREMAP_WORLD_ID")"
      fi
    fi
  elif [[ "$SETUP_MODE" == "crafty" ]]; then
    PLUGIN_URL=""
    SQUAREMAP_URL=""
    if [[ "$NON_INTERACTIVE" != 1 ]]; then
      CRAFTY_URL="$(pp_prompt 'Crafty API address (IP, host, or URL)' "${CRAFTY_URL:-https://host.docker.internal:8443}")"
      if [[ -z "${CRAFTY_API_TOKEN:-}" && -z "${CRAFTY_USERNAME:-}" ]]; then
        CRAFTY_API_TOKEN="$(pp_read_secret_once 'Crafty API token (press Enter to configure it later in the web UI)')"
      fi
    fi
  else
    PLUGIN_URL=""
    CRAFTY_URL=""
    SQUAREMAP_URL=""
  fi
}

read_initial_secrets() {
  if [[ "$NON_INTERACTIVE" == 1 ]]; then
    [[ -n "${PLAYER_PANEL_ADMIN_PASSWORD:-}" ]] || pp_fail "PLAYER_PANEL_ADMIN_PASSWORD is required in non-interactive mode."
    ADMIN_PASSWORD_VALUE="$PLAYER_PANEL_ADMIN_PASSWORD"
  else
    ADMIN_PASSWORD_VALUE="$(pp_read_secret_twice 'Initial admin user password' 10)"
  fi
  [[ -n "$ADMIN_PASSWORD_VALUE" ]] || pp_fail "The administrator password cannot be empty."
  (( ${#ADMIN_PASSWORD_VALUE} >= 10 )) || pp_fail "The administrator password must contain at least 10 characters."

  PLUGIN_TOKEN_VALUE="${PLAYER_PANEL_API_TOKEN:-}"
  CRAFTY_USER_VALUE="${CRAFTY_USERNAME:-}"
  CRAFTY_PASSWORD_VALUE="${CRAFTY_PASSWORD:-}"
  CRAFTY_TOKEN_VALUE="${CRAFTY_API_TOKEN:-}"
}

backup_existing_installation() {
  [[ -e "$INSTALL_ROOT" ]] || return 0
  if [[ "$FORCE" != 1 ]]; then
    if [[ "$NON_INTERACTIVE" != 1 ]] && pp_confirm "Existing path: $INSTALL_ROOT. Back it up and replace it?" no; then
      FORCE=1
    else
      pp_fail "Existing path: $INSTALL_ROOT. Use update-web.sh to update or --force to replace it."
    fi
  fi
  local backup="${INSTALL_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$INSTALL_ROOT" "$backup"
  pp_ok "Previous installation backed up to $backup"
}

write_environment() {
  local trusted secure=false
  trusted="$(trusted_proxy_cidrs)"
  cat > "$INSTALL_ROOT/.env" <<ENV_FILE
PLAYER_PANEL_CONTAINER_NAME=$WEB_CONTAINER
PLAYER_PANEL_NETWORK=$NETWORK
PLAYER_PANEL_BIND_ADDRESS=$BIND_ADDRESS
PLAYER_PANEL_WEB_ACCESS_MODE=direct
PLAYER_PANEL_WEB_PORT=$WEB_PORT
PLAYER_PANEL_API_URL=$PLUGIN_URL
CRAFTY_API_URL=$CRAFTY_URL
CRAFTY_SERVER_ID=
CRAFTY_PANEL_URL=$CRAFTY_PANEL_URL_VALUE
CRAFTY_VERIFY_TLS=false
TZ=$TIMEZONE_NAME
VAPID_SUBJECT=$VAPID_SUBJECT_VALUE
COOKIE_SECURE=$secure
TRUST_PROXY=true
TRUSTED_PROXY_CIDRS=$trusted
MINECRAFT_ASSET_VERSION=$MINECRAFT_ASSET_VERSION_VALUE
MINECRAFT_AUTH_MODE=$MINECRAFT_AUTH_MODE_VALUE
PLAYER_PANEL_SETUP_MODE=$SETUP_MODE
PLAYER_PANEL_SQUAREMAP_URL=$SQUAREMAP_URL
PLAYER_PANEL_SQUAREMAP_WORLD_ID=$SQUAREMAP_WORLD_ID
ENV_FILE
  chmod 0600 "$INSTALL_ROOT/.env"
}

write_secrets() {
  printf '%s' "$PLUGIN_TOKEN_VALUE" > "$INSTALL_ROOT/secrets/player_panel_api_token.txt"
  printf '%s' "$ADMIN_PASSWORD_VALUE" > "$INSTALL_ROOT/secrets/admin_password.txt"
  openssl rand -hex 32 > "$INSTALL_ROOT/secrets/session_secret.txt"
  printf '%s' "$CRAFTY_USER_VALUE" > "$INSTALL_ROOT/secrets/crafty_username.txt"
  printf '%s' "$CRAFTY_PASSWORD_VALUE" > "$INSTALL_ROOT/secrets/crafty_password.txt"
  printf '%s' "$CRAFTY_TOKEN_VALUE" > "$INSTALL_ROOT/secrets/crafty_api_token.txt"
  chmod 0600 "$INSTALL_ROOT/secrets"/*.txt
  unset ADMIN_PASSWORD_VALUE PLUGIN_TOKEN_VALUE CRAFTY_PASSWORD_VALUE CRAFTY_TOKEN_VALUE
}

install_panel() {
  backup_existing_installation
  mkdir -p "$INSTALL_ROOT"
  cp -a "$BUNDLE_DIR/components/web/." "$INSTALL_ROOT/"
  mkdir -p "$INSTALL_ROOT/data" "$INSTALL_ROOT/secrets"
  chmod 0700 "$INSTALL_ROOT/data" "$INSTALL_ROOT/secrets"

  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
  write_environment
  write_secrets

  pp_log "Building Player Panel Web $WEB_VERSION..."
  (
    cd "$INSTALL_ROOT"
    if [[ "$NO_CACHE" == 1 ]]; then
      docker compose --env-file .env build --no-cache
    else
      docker compose --env-file .env build
    fi
  )

  local image uid gid
  image="$(cd "$INSTALL_ROOT" && docker compose --env-file .env config --images | head -n1)"
  uid="$(docker run --rm --entrypoint sh "$image" -c 'id -u playerpanel')"
  gid="$(docker run --rm --entrypoint sh "$image" -c 'id -g playerpanel')"
  chown "$uid:$gid" "$INSTALL_ROOT/secrets"/*.txt
  chown -R "$uid:$gid" "$INSTALL_ROOT/data"
  chmod 0600 "$INSTALL_ROOT/secrets"/*.txt
  chmod 0700 "$INSTALL_ROOT/secrets" "$INSTALL_ROOT/data"

  (cd "$INSTALL_ROOT" && docker compose --env-file .env up -d --force-recreate)
}

wait_for_health() {
  if [[ "$TEST_MODE" == 1 ]]; then
    pp_ok "Test: simulated web health for $WEB_VERSION."
    return 0
  fi
  local deadline=$((SECONDS + 120)) health state restart_count logs
  while (( SECONDS < deadline )); do
    if health="$(curl -fsS "http://127.0.0.1:$WEB_PORT/healthz" 2>/dev/null)"; then
      if grep -q "\"version\":\"$WEB_VERSION\"" <<<"$health"; then
        pp_ok "Player Panel Web $WEB_VERSION is healthy."
        return 0
      fi
    fi

    state="$(docker inspect -f '{{.State.Status}}' "$WEB_CONTAINER" 2>/dev/null || true)"
    restart_count="$(docker inspect -f '{{.RestartCount}}' "$WEB_CONTAINER" 2>/dev/null || echo 0)"
    if [[ "$state" == "restarting" || "$state" == "exited" || "$state" == "dead" ]]; then
      logs="$(docker logs --tail=80 "$WEB_CONTAINER" 2>&1 || true)"
      printf '%s
' "$logs" >&2
      if grep -qi 'admin password must contain at least 10 characters' <<<"$logs"; then
        pp_fail "The container rejected the initial password: it must contain at least 10 characters. Correct secrets/admin_password.txt and restart the container."
      fi
      pp_fail "Player Panel could not start. Container state: ${state:-unknown}; restarts: ${restart_count:-0}. Review the logs shown above."
    fi
    sleep 2
  done
  (cd "$INSTALL_ROOT" && docker compose --env-file .env logs --tail=80) || true
  pp_fail "Player Panel did not respond correctly on port $WEB_PORT after 120 seconds."
}

write_report() {
  local host_ip="$1"
  cat > "$INSTALL_ROOT/install-report.txt" <<REPORT
Player Panel web-only install report
Generated: $(date -Is)
Bundle: $BUNDLE_VERSION
Web: $WEB_VERSION
Install root: $INSTALL_ROOT
Container: $WEB_CONTAINER
Bind: $BIND_ADDRESS
Port: $WEB_PORT
Local URL: http://127.0.0.1:$WEB_PORT
Network URL: http://$host_ip:$WEB_PORT
Plugin API initial URL: $PLUGIN_URL
Crafty initial URL: $CRAFTY_URL
Initial setup mode: $SETUP_MODE
Initial squaremap URL: $SQUAREMAP_URL
Initial squaremap world: $SQUAREMAP_WORLD_ID
REPORT
  chmod 0600 "$INSTALL_ROOT/install-report.txt"
}

main() {
  echo "Player Panel — web-only installer $BUNDLE_VERSION"
  [[ -d "$BUNDLE_DIR/components/web/app" ]] || pp_fail "components/web/app is missing."
  [[ -f "$BUNDLE_DIR/components/web/docker-compose.yml" ]] || pp_fail "docker-compose.yml is missing."
  pp_validate_port "$WEB_PORT" || pp_fail "Invalid port: $WEB_PORT"
  [[ -z "$PLUGIN_URL" ]] || PLUGIN_URL="$(normalize_service_address "$PLUGIN_URL" plugin)"
  [[ -z "$SQUAREMAP_URL" ]] || SQUAREMAP_URL="$(normalize_service_address "$SQUAREMAP_URL" squaremap)"
  [[ -z "$CRAFTY_URL" ]] || CRAFTY_URL="$(normalize_service_address "$CRAFTY_URL" crafty)"
  if [[ "$SETUP_MODE" == "manual" && -z "$PLUGIN_URL" ]]; then
    pp_fail "Manual mode requires --plugin-url or an address entered in the wizard. Use --setup-mode later to configure everything from the web UI."
  fi
  [[ -z "$PLUGIN_URL" ]] || validate_url "$PLUGIN_URL" || pp_fail "Invalid plugin address: $PLUGIN_URL"
  [[ -z "$SQUAREMAP_URL" ]] || validate_url "$SQUAREMAP_URL" || pp_fail "Invalid squaremap address: $SQUAREMAP_URL"
  [[ -z "$CRAFTY_URL" ]] || validate_url "$CRAFTY_URL" || pp_fail "Invalid Crafty address: $CRAFTY_URL"
  command -v curl >/dev/null 2>&1 || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y curl; }
  command -v openssl >/dev/null 2>&1 || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y openssl; }

  ensure_docker
  detect_timezone
  choose_setup_mode
  [[ -z "$PLUGIN_URL" ]] || PLUGIN_URL="$(normalize_service_address "$PLUGIN_URL" plugin)"
  [[ -z "$SQUAREMAP_URL" ]] || SQUAREMAP_URL="$(normalize_service_address "$SQUAREMAP_URL" squaremap)"
  [[ -z "$CRAFTY_URL" ]] || CRAFTY_URL="$(normalize_service_address "$CRAFTY_URL" crafty)"
  if [[ "$SETUP_MODE" == "manual" && -z "$PLUGIN_URL" ]]; then
    pp_fail "Manual mode requires --plugin-url or an address entered in the wizard. Use --setup-mode later to configure everything from the web UI."
  fi
  [[ -z "$PLUGIN_URL" ]] || validate_url "$PLUGIN_URL" || pp_fail "Invalid plugin address: $PLUGIN_URL"
  [[ -z "$SQUAREMAP_URL" ]] || validate_url "$SQUAREMAP_URL" || pp_fail "Invalid squaremap address: $SQUAREMAP_URL"
  [[ -z "$CRAFTY_URL" ]] || validate_url "$CRAFTY_URL" || pp_fail "Invalid Crafty address: $CRAFTY_URL"
  local host_ip
  host_ip="$(pp_detect_host_ipv4)"
  pp_ok "Primary IP detected: $host_ip"

  if [[ "$NON_INTERACTIVE" != 1 && "$ASSUME_YES" != 1 ]]; then
    echo
    echo "Only Player Panel Web will be installed."
    echo "Crafty and Minecraft servers will not be modified."
    echo "Expected access: http://$host_ip:$WEB_PORT"
    pp_confirm "Continue?" yes || exit 0
  fi

  read_initial_secrets
  install_panel
  wait_for_health
  pp_open_tcp_port "$WEB_PORT" "Player Panel"
  write_report "$host_ip"

  echo
  echo "============================================================"
  echo "Player Panel Web $WEB_VERSION installed"
  echo "============================================================"
  echo "Panel: http://$host_ip:$WEB_PORT"
  echo "Local panel: http://127.0.0.1:$WEB_PORT"
  [[ -n "$PUBLIC_URL" ]] && echo "Configured public URL: $PUBLIC_URL"
  echo "Initial user: admin"
  echo "Path: $INSTALL_ROOT"
  echo
  echo "Crafty, Minecraft, Fabric, and maps were not modified."
  case "$SETUP_MODE" in
    manual)
      echo "Selected workflow: direct plugin connection without Crafty."
      [[ -n "$SQUAREMAP_URL" ]] && echo "Initial squaremap: $SQUAREMAP_URL · world $SQUAREMAP_WORLD_ID"
      ;;
    crafty) echo "Selected workflow: import and manage servers through Crafty." ;;
    later) echo "Selected workflow: start with no servers and add them from the web UI." ;;
  esac
  if [[ "$SETUP_MODE" == "later" ]]; then
    echo "After login, the Add Server wizard opens automatically."
    echo "No server profile is created until you choose a direct connection or Crafty."
  else
    echo "After login, the panel continues with the selected workflow."
  fi
  echo "If the panel does not open from another device, allow TCP/$WEB_PORT in the provider firewall."
}

main "$@"
