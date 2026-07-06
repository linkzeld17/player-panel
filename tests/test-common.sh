#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$ROOT/scripts/lib/common.sh"
export PP_NON_INTERACTIVE=0
pp_confirm 'Default confirmation' yes <<< ''
pp_confirm 'Short confirmation' yes <<< 'y'
pp_confirm 'Uppercase short confirmation' yes <<< 'Y'
if pp_confirm 'Default rejection' no <<< ''; then
  echo '[FAIL] An empty [y/N] confirmation must not be accepted.' >&2
  exit 1
fi
echo PLAYER_PANEL_COMMON_CONFIRM_TEST_OK
