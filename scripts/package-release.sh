#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
WEB_VERSION="$(python3 - <<'PY' "$ROOT/components/web/app/server.py"
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text(encoding='utf-8')
m = re.search(r'^APP_VERSION\s*=\s*"([^"]+)"', text, re.M)
if not m:
    raise SystemExit('APP_VERSION not found')
print(m.group(1))
PY
)"
DIST="$ROOT/dist"
FULL_NAME="player-panel-$VERSION"
WEB_NAME="player-panel-web-only-$WEB_VERSION"

rm -rf "$DIST"
mkdir -p "$DIST/$FULL_NAME" "$DIST/$WEB_NAME"

copy_full() {
  local target="$1"
  tar \
    --exclude='./.git' \
    --exclude='./dist' \
    --exclude='./data' \
    --exclude='./secrets' \
    --exclude='./update-backups' \
    --exclude='./__pycache__' \
    --exclude='*.pyc' \
    -C "$ROOT" -cf - . | tar -C "$target" -xf -
}

copy_full "$DIST/$FULL_NAME"

mkdir -p "$DIST/$WEB_NAME/components" "$DIST/$WEB_NAME/scripts/lib"
cp -a "$ROOT/components/web" "$DIST/$WEB_NAME/components/"
cp -a "$ROOT/scripts/lib/common.sh" "$DIST/$WEB_NAME/scripts/lib/"
cp -a "$ROOT/install-panel-only.sh" "$ROOT/update-web.sh" "$ROOT/LICENSE" \
  "$ROOT/SECURITY.md" "$ROOT/THIRD_PARTY_NOTICES.md" "$ROOT/VERSION" \
  "$DIST/$WEB_NAME/"
cat > "$DIST/$WEB_NAME/README.md" <<README
# Player Panel Web Only $WEB_VERSION

This archive installs only Player Panel Web. It does not install or modify Crafty, Minecraft, Fabric, BlueMap, or squaremap.

See the main repository documentation for full instructions.

\`\`\`bash
chmod +x install-panel-only.sh update-web.sh scripts/lib/*.sh
./install-panel-only.sh
\`\`\`
README

for dir in "$DIST/$FULL_NAME" "$DIST/$WEB_NAME"; do
  (
    cd "$dir"
    find . -type f ! -name CHECKSUMS.sha256 -print0 | sort -z | xargs -0 sha256sum > CHECKSUMS.sha256
  )
done

(
  cd "$DIST"
  zip -qr "$FULL_NAME.zip" "$FULL_NAME"
  zip -qr "$WEB_NAME.zip" "$WEB_NAME"
  sha256sum "$FULL_NAME.zip" "$WEB_NAME.zip" > SHA256SUMS
)

printf 'Created:\n'
printf '  %s\n' "$DIST/$FULL_NAME.zip" "$DIST/$WEB_NAME.zip" "$DIST/SHA256SUMS"
