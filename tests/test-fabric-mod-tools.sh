#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/lib/fabric-mods.sh
source "$ROOT/scripts/lib/fabric-mods.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

make_jar() {
  local output="$1" mod_id="$2" version="$3"
  python3 - "$output" "$mod_id" "$version" <<'PY'
import json
import sys
import zipfile
from pathlib import Path

output = Path(sys.argv[1])
metadata = {
    "schemaVersion": 1,
    "id": sys.argv[2],
    "version": sys.argv[3],
    "name": "Fixture",
    "environment": "server",
}
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as jar:
    jar.writestr("fabric.mod.json", json.dumps(metadata))
PY
}

make_jar "$TMP/fabric-api.jar" fabric-api '0.153.0+26.1.2'
make_jar "$TMP/squaremap-renamed.jar" squaremap '1.3.13'
make_jar "$TMP/bluemap-custom-name.jar" bluemap '5.20'
make_jar "$TMP/wrong.jar" another-mod '1.0.0'

mkdir -p "$TMP/mods" "$TMP/bin"
cp "$TMP/fabric-api.jar" "$TMP/mods/api-renamed-by-admin.jar"
cp "$TMP/squaremap-renamed.jar" "$TMP/mods/world-map-custom.jar"
cp "$TMP/bluemap-custom-name.jar" "$TMP/mods/three-dimensional-map.jar"
cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == exec ]] || exit 1
shift
[[ "${1:-}" == -i ]] && shift
shift # container
[[ "${1:-}" == python3 && "${2:-}" == - ]] || exit 1
shift 2
python3 - "${PLAYER_PANEL_TEST_MODS:?}"
MOCK
chmod +x "$TMP/bin/docker"
export PLAYER_PANEL_TEST_MODS="$TMP/mods"
PATH="$TMP/bin:$PATH"

fabric_detected="$(pp_fabric_mod_info fixture /crafty/servers/example fabric-api)"
square_detected="$(pp_fabric_mod_info fixture /crafty/servers/example squaremap)"
blue_detected="$(pp_fabric_mod_info fixture /crafty/servers/example bluemap)"

IFS=$'\t' read -r fabric_id fabric_version fabric_path fabric_source <<<"$fabric_detected"
IFS=$'\t' read -r square_id square_version square_path square_source <<<"$square_detected"
IFS=$'\t' read -r blue_id blue_version blue_path blue_source <<<"$blue_detected"
[[ "$fabric_id" == fabric-api && "$fabric_version" == '0.153.0+26.1.2' ]]
[[ "$fabric_path" == */api-renamed-by-admin.jar && "$fabric_source" == metadata ]]
[[ "$square_id" == squaremap && "$square_version" == '1.3.13' ]]
[[ "$square_path" == */world-map-custom.jar && "$square_source" == metadata ]]
[[ "$blue_id" == bluemap && "$blue_version" == '5.20' ]]
[[ "$blue_path" == */three-dimensional-map.jar && "$blue_source" == metadata ]]

[[ "$(pp_validate_fabric_jar "$TMP/fabric-api.jar" fabric-api '0.153.0+26.1.2')" == $'fabric-api\t0.153.0+26.1.2' ]]
[[ "$(pp_validate_fabric_jar "$TMP/squaremap-renamed.jar" squaremap '1.3.13')" == $'squaremap\t1.3.13' ]]
[[ "$(pp_validate_fabric_jar "$TMP/bluemap-custom-name.jar" bluemap '5.20')" == $'bluemap\t5.20' ]]

pp_version_at_least '0.153.0+26.1.2' '0.153.0'
pp_version_at_least '0.154.0' '0.153.0'
! pp_version_at_least '0.152.9' '0.153.0'
! pp_validate_fabric_jar "$TMP/wrong.jar" fabric-api '1.0.0' >/dev/null 2>&1
! pp_validate_fabric_jar "$TMP/fabric-api.jar" fabric-api '0.154.0' >/dev/null 2>&1

echo PLAYER_PANEL_FABRIC_MOD_TOOLS_TEST_OK
