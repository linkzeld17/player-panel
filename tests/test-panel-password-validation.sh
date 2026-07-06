#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/common.sh"

PP_NON_INTERACTIVE=1
PLAYER_PANEL_ADMIN_PASSWORD='123456789'
if (pp_read_secret_twice 'Test' 10 >/dev/null 2>&1); then
  echo '[FAIL] A 9-character password was accepted.' >&2
  exit 1
fi

PLAYER_PANEL_ADMIN_PASSWORD='1234567890'
[[ "$(pp_read_secret_twice 'Test' 10)" == '1234567890' ]]

grep -q 'administrator password must contain at least 10 characters' "$ROOT/install-panel-only.sh"
grep -q 'Container state' "$ROOT/install-panel-only.sh"
echo PLAYER_PANEL_PASSWORD_VALIDATION_TEST_OK
