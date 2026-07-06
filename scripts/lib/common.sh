#!/usr/bin/env bash
set -Eeuo pipefail

pp_log() { printf '[INFO] %s\n' "$*"; }
pp_ok() { printf '[OK] %s\n' "$*"; }
pp_warn() { printf '[WARNING] %s\n' "$*" >&2; }
pp_fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

pp_need() {
  command -v "$1" >/dev/null 2>&1 || pp_fail "Required command is missing: $1"
}

pp_is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

pp_confirm() {
  local prompt="$1" default="${2:-yes}" answer
  if [[ "${PP_NON_INTERACTIVE:-0}" == 1 ]]; then
    pp_is_true "$default"
    return
  fi
  if [[ "$default" == yes ]]; then
    read -r -p "$prompt [Y/n]: " answer
    answer="${answer:-y}"
  else
    read -r -p "$prompt [y/N]: " answer
    answer="${answer:-n}"
  fi
  pp_is_true "$answer"
}

pp_prompt() {
  local prompt="$1" default="${2:-}" answer
  if [[ "${PP_NON_INTERACTIVE:-0}" == 1 ]]; then
    printf '%s' "$default"
    return
  fi
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " answer
    printf '%s' "${answer:-$default}"
  else
    read -r -p "$prompt: " answer
    printf '%s' "$answer"
  fi
}

pp_read_secret_twice() {
  local label="$1" min_length="${2:-1}" first second
  if [[ "${PP_NON_INTERACTIVE:-0}" == 1 ]]; then
    [[ -n "${PLAYER_PANEL_ADMIN_PASSWORD:-}" ]] || pp_fail "PLAYER_PANEL_ADMIN_PASSWORD is required in non-interactive mode."
    (( ${#PLAYER_PANEL_ADMIN_PASSWORD} >= min_length )) || pp_fail "PLAYER_PANEL_ADMIN_PASSWORD must contain at least ${min_length} characters."
    printf '%s' "$PLAYER_PANEL_ADMIN_PASSWORD"
    return
  fi
  trap 'stty echo 2>/dev/null || true' RETURN
  while true; do
    printf '%s: ' "$label" >&2
    stty -echo
    IFS= read -r first
    stty echo
    printf '
Repeat the password: ' >&2
    stty -echo
    IFS= read -r second
    stty echo
    printf '
' >&2
    if [[ "$first" != "$second" ]]; then
      pp_warn "The passwords do not match. Try again."
      continue
    fi
    if (( ${#first} < min_length )); then
      pp_warn "The password must contain at least ${min_length} characters. Try again."
      continue
    fi
    printf '%s' "$first"
    return
  done
}

pp_read_secret_once() {
  local label="$1" value
  if [[ "${PP_NON_INTERACTIVE:-0}" == 1 ]]; then
    printf '%s' "${2:-}"
    return
  fi
  trap 'stty echo 2>/dev/null || true' RETURN
  printf '%s: ' "$label" >&2
  stty -echo
  IFS= read -r value
  stty echo
  printf '\n' >&2
  printf '%s' "$value"
}

pp_validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 ))
}

pp_sha256() {
  sha256sum "$1" | awk '{print $1}'
}
pp_detect_host_ipv4() {
  local candidate="${PLAYER_PANEL_HOST_IP:-}"
  if [[ -n "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi

  if [[ "${PLAYER_PANEL_TEST_MODE:-0}" == 1 ]]; then
    printf '%s' '192.0.2.10'
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    candidate="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
    if [[ -z "$candidate" ]]; then
      candidate="$(ip -o -4 addr show scope global 2>/dev/null | awk '{split($4,a,"/"); if (a[1] !~ /^127\./ && a[1] !~ /^169\.254\./) {print a[1]; exit}}')"
    fi
  fi

  if [[ -z "$candidate" ]] && command -v hostname >/dev/null 2>&1; then
    candidate="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $0 !~ /^127\./ && $0 !~ /^169\.254\./ {print; exit}')"
  fi

  printf '%s' "${candidate:-127.0.0.1}"
}

pp_open_tcp_port() {
  local port="$1" label="${2:-service}"
  pp_validate_port "$port" || return 1
  [[ "${PLAYER_PANEL_TEST_MODE:-0}" == 0 ]] || return 0

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$port/tcp" >/dev/null
    pp_ok "UFW allows TCP/$port for $label."
    return 0
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$port/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    pp_ok "firewalld allows TCP/$port for $label."
    return 0
  fi

  return 0
}

