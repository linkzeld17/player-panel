#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="${1:-crafty-controller}"
UUID="${2:-}"

[[ -n "$UUID" ]] || {
  echo "Usage: $0 CONTAINER UUID" >&2
  exit 2
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$(cd -- "$SCRIPT_DIR/../.." && pwd)/integrations/squaremap/player-panel-squaremap-bridge-v7.js"

[[ -f "$BRIDGE" ]] || {
  echo "[ERROR] Missing $BRIDGE" >&2
  exit 1
}

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "[ERROR] Missing container: $CONTAINER" >&2
  exit 1
}

ROOT="/crafty/servers/$UUID"

CONFIG="$(
  docker exec "$CONTAINER" sh -lc "
    set -eu
    for f in \
      '$ROOT/squaremap/config.yml' \
      '$ROOT/plugins/squaremap/config.yml' \
      '$ROOT/plugins/Squaremap/config.yml' \
      '$ROOT/config/squaremap/config.yml'
    do
      if [ -f \"\$f\" ]; then
        printf '%s\n' \"\$f\"
        exit 0
      fi
    done

    find '$ROOT' -maxdepth 6 -type f -path '*/squaremap/config.yml' -print -quit
  " | tr -d '\r'
)"

[[ -n "$CONFIG" ]] || {
  echo "[ERROR] squaremap config.yml was not found." >&2
  exit 1
}

WEBROOT="$(
  docker exec -i "$CONTAINER" python3 - "$CONFIG" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

config = Path(sys.argv[1])
lines = config.read_text(encoding="utf-8").splitlines()

def indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))

def nested_value(keys: list[str], default: str = "") -> str:
    start, end, parent_indent = 0, len(lines), -1

    for key in keys[:-1]:
        pattern = re.compile(r"^(\s*)" + re.escape(key) + r":\s*(?:#.*)?$")
        found = None
        for i in range(start, end):
            match = pattern.match(lines[i])
            if match and len(match.group(1)) > parent_indent:
                found = (i, len(match.group(1)))
                break
        if found is None:
            return default
        pos, parent_indent = found
        start, end = pos + 1, len(lines)
        for j in range(start, len(lines)):
            stripped = lines[j].strip()
            if stripped and not stripped.startswith("#") and indent(lines[j]) <= parent_indent:
                end = j
                break

    leaf = keys[-1]
    pattern = re.compile(r"^(\s*)" + re.escape(leaf) + r":\s*(.*?)\s*(?:#.*)?$")
    for i in range(start, end):
        match = pattern.match(lines[i])
        if match and len(match.group(1)) > parent_indent:
            return match.group(2).strip().strip("'\"")
    return default

web_path = nested_value(["settings", "web-directory", "path"], "web")
webroot = Path(web_path)
if not webroot.is_absolute():
    webroot = config.parent / webroot

print(webroot)
PY
)"

WEBROOT="$(printf '%s' "$WEBROOT" | tr -d '\r')"

if ! docker exec "$CONTAINER" test -f "$WEBROOT/index.html"; then
  echo "[ERROR] Missing $WEBROOT/index.html" >&2
  echo "Detected config: $CONFIG" >&2
  echo "Detected web root: $WEBROOT" >&2
  echo >&2
  echo "Start squaremap and wait for it to generate the web files before installing the bridge." >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
docker exec "$CONTAINER" cp -p \
  "$WEBROOT/index.html" \
  "$WEBROOT/index.html.pre-player-panel-squaremap-$STAMP"
docker exec "$CONTAINER" cp -p \
  "$CONFIG" \
  "$CONFIG.pre-player-panel-squaremap-$STAMP"

docker exec "$CONTAINER" rm -f \
  "$WEBROOT/player-panel-squaremap-bridge-v1.js" \
  "$WEBROOT/player-panel-squaremap-bridge-v2.js" \
  "$WEBROOT/player-panel-squaremap-bridge-v3.js" \
  "$WEBROOT/player-panel-squaremap-bridge-v4.js" \
  "$WEBROOT/player-panel-squaremap-bridge-v5.js" \
  "$WEBROOT/player-panel-squaremap-bridge-v6.js" \
  "$WEBROOT/player-panel-squaremap-bridge-v7.js"

docker cp "$BRIDGE" \
  "$CONTAINER:$WEBROOT/player-panel-squaremap-bridge-v7.js"

# The bridge is copied as root, but squaremap writes its web files as `crafty`.
# Keeping the same owner prevents a later regeneration from failing or
# leave the directory partially inaccessible.
docker exec "$CONTAINER" sh -lc "
  set -eu
  chown -R crafty:root '$WEBROOT' 2>/dev/null || true
  find '$WEBROOT' -type d -exec chmod 0775 {} + 2>/dev/null || true
  find '$WEBROOT' -type f -exec chmod 0664 {} + 2>/dev/null || true
  chown crafty:root '$CONFIG' 2>/dev/null || true
  chmod 0664 '$CONFIG' 2>/dev/null || true
"

docker exec -i "$CONTAINER" python3 - "$WEBROOT/index.html" "$CONFIG" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

index = Path(sys.argv[1])
config = Path(sys.argv[2])

html = index.read_text(encoding="utf-8")
html = re.sub(
    r"\s*<!-- player-panel-squaremap-bridge:start -->.*?"
    r"<!-- player-panel-squaremap-bridge:end -->\s*",
    "\n",
    html,
    flags=re.S,
)

# Remove the temporary normalizer used before Web 1.7.2.
html = re.sub(
    r"\s*<!-- player-panel-squaremap-world-normalizer:start -->.*?"
    r"<!-- player-panel-squaremap-world-normalizer:end -->\s*",
    "\n",
    html,
    flags=re.S,
)
html = re.sub(
    r"\s*<script[^>]*(?:id=[\"']player-panel-squaremap-world-normalizer[\"']|"
    r"src=[\"'][^\"']*player-panel-squaremap-world-normalizer[^\"']*)[^>]*>.*?</script>\s*",
    "\n",
    html,
    flags=re.S | re.I,
)

block = (
    "\n<!-- player-panel-squaremap-bridge:start -->\n"
    '<script defer src="player-panel-squaremap-bridge-v7.js?v=7"></script>\n'
    "<!-- player-panel-squaremap-bridge:end -->\n"
)

match = re.search(r"</body\s*>", html, flags=re.I)
if not match:
    raise SystemExit("index.html no contiene </body>")

html = html[:match.start()] + block + html[match.start():]
index.write_text(html, encoding="utf-8")

lines = config.read_text(encoding="utf-8").splitlines()

def indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))

# Change only settings.web-directory.auto-update.
settings_start = web_start = None
settings_indent = web_indent = -1

for i, line in enumerate(lines):
    match = re.match(r"^(\s*)settings:\s*(?:#.*)?$", line)
    if match:
        settings_start = i
        settings_indent = len(match.group(1))
        break

if settings_start is not None:
    settings_end = len(lines)
    for i in range(settings_start + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped and not stripped.startswith("#") and indent(lines[i]) <= settings_indent:
            settings_end = i
            break

    for i in range(settings_start + 1, settings_end):
        match = re.match(r"^(\s*)web-directory:\s*(?:#.*)?$", lines[i])
        if match and len(match.group(1)) > settings_indent:
            web_start = i
            web_indent = len(match.group(1))
            break

if web_start is not None:
    web_end = len(lines)
    for i in range(web_start + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped and not stripped.startswith("#") and indent(lines[i]) <= web_indent:
            web_end = i
            break

    for i in range(web_start + 1, web_end):
        match = re.match(r"^(\s*)auto-update:\s*.*$", lines[i])
        if match and len(match.group(1)) > web_indent:
            lines[i] = f"{match.group(1)}auto-update: false"
            break

config.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("INDEX_PATCHED")
PY

docker exec "$CONTAINER" sh -lc "
  set -eu
  chown -R crafty:root '$WEBROOT' 2>/dev/null || true
  find '$WEBROOT' -type d -exec chmod 0775 {} + 2>/dev/null || true
  find '$WEBROOT' -type f -exec chmod 0664 {} + 2>/dev/null || true
  chown crafty:root '$CONFIG' 2>/dev/null || true
  chmod 0664 '$CONFIG' 2>/dev/null || true
"

echo
echo "[OK] squaremap bridge v4 installed"
echo "Config  : $CONFIG"
echo "Webroot : $WEBROOT"
echo "[OK] settings.web-directory.auto-update was set to false."
echo
echo "Reload the browser. Do not run /map reload after installing the bridge."
