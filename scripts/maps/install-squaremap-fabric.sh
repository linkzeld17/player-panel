#!/usr/bin/env bash
set -Eeuo pipefail
CONTAINER="${1:-crafty-controller}"
UUID="${2:-}"
[[ -n "$UUID" ]] || { echo "Usage: $0 CONTAINER UUID" >&2; exit 2; }
VERSION="1.3.13"
FILE="squaremap-fabric-mc26.1.2-${VERSION}.jar"
URL="https://github.com/jpenilla/squaremap/releases/download/v${VERSION}/${FILE}"
EXPECTED="b3e8fc558c322e6fc8b47073ae878725612f5c52aa5a8caa1c2bc4bc38f33211"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
command -v curl >/dev/null || { echo "[ERROR] curl is required" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null
ROOT="/crafty/servers/$UUID"; docker exec "$CONTAINER" test -d "$ROOT/mods"
echo "Descargando squaremap Fabric ${VERSION} oficial..."
curl -fL --retry 3 --connect-timeout 15 "$URL" -o "$TMP/$FILE"
echo "$EXPECTED  $TMP/$FILE" | sha256sum -c -
docker exec "$CONTAINER" sh -lc "mkdir -p '$ROOT/mods'; find '$ROOT/mods' -maxdepth 1 -type f -iname 'squaremap*.jar' -exec mv {} {}.pre-player-panel-$(date +%Y%m%d-%H%M%S) \\;"
docker cp "$TMP/$FILE" "$CONTAINER:$ROOT/mods/$FILE"
echo "[OK] Installed $ROOT/mods/$FILE"
echo "Start the server once to create squaremap/config.yml, then run configure-squaremap.sh."
