#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_FILE="$(cd -- "$SCRIPT_DIR/../.." && pwd)/integrations/bluemap/player-panel-bluemap-bridge-v6.js"
BRIDGE_NAME="player-panel-bluemap-bridge-v6.js"

[[ -f "$BRIDGE_FILE" ]] || { echo "[ERROR] Missing $BRIDGE_FILE" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "[ERROR] Docker is not available." >&2; exit 1; }

CRAFTY_CONTAINER="${1:-crafty-controller}"
docker inspect "$CRAFTY_CONTAINER" >/dev/null 2>&1 || {
  echo "[ERROR] Missing container $CRAFTY_CONTAINER" >&2
  exit 1
}

mapfile -t SERVER_ROWS < <(docker exec -i "$CRAFTY_CONTAINER" python3 - <<'PY'
from pathlib import Path
import os, re, sqlite3
root = Path('/crafty/servers')
uuid_re = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
ids = sorted(p.name for p in root.iterdir() if p.is_dir() and uuid_re.fullmatch(p.name)) if root.is_dir() else []
names = {}
for base in (Path('/crafty/app/config'), Path('/crafty/config')):
    if not base.exists():
        continue
    for current, dirs, files in os.walk(base):
        if len(Path(current).relative_to(base).parts) >= 5:
            dirs[:] = []
        for filename in files:
            if not filename.lower().endswith(('.db', '.sqlite', '.sqlite3')):
                continue
            path = Path(current) / filename
            try:
                con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
                for table, in con.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                    safe = table.replace('"', '""')
                    cols = [r[1] for r in con.execute(f'PRAGMA table_info("{safe}")')]
                    lower = {c.lower(): c for c in cols}
                    ic = next((lower[k] for k in ('server_id', 'server_uuid', 'uuid') if k in lower), None)
                    nc = next((lower[k] for k in ('server_name', 'display_name', 'name') if k in lower), None)
                    if not ic or not nc:
                        continue
                    for sid, name in con.execute(f'SELECT "{ic}", "{nc}" FROM "{safe}"'):
                        sid = str(sid or '').strip()
                        name = str(name or '').strip()
                        if sid in ids and name:
                            names[sid] = name
                con.close()
            except Exception:
                pass
for sid in ids:
    name = names.get(sid, f'Server {sid[:8]}').replace('\t', ' ').replace('\n', ' ')
    print(f'{sid}\t{name}')
PY
)

((${#SERVER_ROWS[@]})) || { echo "[ERROR] No servers were found in Crafty." >&2; exit 1; }

if [[ -n "${2:-}" ]]; then
  SELECTED_UUID="$2"
  SELECTED_NAME="$2"
else
  echo "Crafty servers:"
  for i in "${!SERVER_ROWS[@]}"; do
    IFS=$'\t' read -r sid name <<<"${SERVER_ROWS[$i]}"
    printf '  [%d] %s\n      UUID: %s\n' "$((i + 1))" "$name" "$sid"
  done
  while true; do
    read -r -p "Select the server with BlueMap: " choice
    [[ "$choice" =~ ^[0-9]+$ ]] || continue
    (( choice >= 1 && choice <= ${#SERVER_ROWS[@]} )) || continue
    IFS=$'\t' read -r SELECTED_UUID SELECTED_NAME <<<"${SERVER_ROWS[$((choice - 1))]}"
    break
  done
fi

TMP_INFO="$(mktemp)"
trap 'rm -f "$TMP_INFO"' EXIT

docker exec -i "$CRAFTY_CONTAINER" python3 - "$SELECTED_UUID" >"$TMP_INFO" <<'PY'
from pathlib import Path
import re, sys
root = Path('/crafty/servers') / sys.argv[1]
configs = [root / 'config/bluemap/webapp.conf', root / 'plugins/BlueMap/webapp.conf']
webapp = next((p for p in configs if p.is_file()), None)
if not webapp:
    raise SystemExit('ERROR\twebapp.conf was not found')

webserver_candidates = [webapp.parent / 'webserver.conf', root / 'config/bluemap/webserver.conf', root / 'plugins/BlueMap/webserver.conf']
webserver = next((p for p in webserver_candidates if p.is_file()), None)

roots = []
def resolve_webroot(path):
    if not path or not path.is_file():
        return
    text = path.read_text('utf-8', errors='replace')
    m = re.search(r'(?im)^\s*webroot\s*:\s*["\']?([^"\'\r\n#]+)', text)
    if not m:
        return
    candidate = Path(m.group(1).strip())
    resolved = candidate if candidate.is_absolute() else root / candidate
    if resolved not in roots:
        roots.append(resolved)

# BlueMap may have a generated web root and a served web root; handle both.
resolve_webroot(webapp)
resolve_webroot(webserver)
default = root / 'bluemap/web'
if default not in roots:
    roots.append(default)

existing = [p for p in roots if (p / 'index.html').is_file()]
if existing:
    ordered = existing + [p for p in roots if p not in existing]
else:
    ordered = roots

print(f'WEBAPP\t{webapp}')
print(f'WEBSERVER\t{webserver or ""}')
for webroot in ordered:
    print(f'WEBROOT\t{webroot}')
PY

if grep -q '^ERROR' "$TMP_INFO"; then
  cat "$TMP_INFO" >&2
  exit 1
fi

WEBAPP_CONFIG="$(awk -F '\t' '$1=="WEBAPP"{print $2; exit}' "$TMP_INFO")"
WEBSERVER_CONFIG="$(awk -F '\t' '$1=="WEBSERVER"{print $2; exit}' "$TMP_INFO")"
mapfile -t WEBROOTS < <(awk -F '\t' '$1=="WEBROOT"{print $2}' "$TMP_INFO")

[[ -n "$WEBAPP_CONFIG" ]] || { echo "[ERROR] webapp.conf was not detected." >&2; exit 1; }
((${#WEBROOTS[@]})) || { echo "[ERROR] No web root was detected." >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
echo
echo "Server        : $SELECTED_NAME"
echo "UUID          : $SELECTED_UUID"
echo "webapp.conf   : $WEBAPP_CONFIG"
[[ -n "$WEBSERVER_CONFIG" ]] && echo "webserver.conf: $WEBSERVER_CONFIG"
printf 'Webroots:\n'
printf '  - %s\n' "${WEBROOTS[@]}"

docker exec "$CRAFTY_CONTAINER" cp -p "$WEBAPP_CONFIG" "$WEBAPP_CONFIG.pre-player-panel-v6-$STAMP"

# Register the new script and remove the previous RC4 reference.
docker exec -i "$CRAFTY_CONTAINER" python3 - "$WEBAPP_CONFIG" "$BRIDGE_NAME" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
name = sys.argv[2]
text = path.read_text('utf-8', errors='replace')

# Remove old bridge references to avoid duplicate execution.
text = re.sub(r'(?m)^\s*["\']player-panel-bluemap-bridge(?:-v[0-9]+)?\.js["\']\s*,?\s*$', '', text)

pattern = re.compile(r'(?ms)(^(?P<indent>\s*)scripts\s*:\s*\[)(.*?)(\])')
m = pattern.search(text)
if m:
    indent = m.group('indent')
    body = m.group(3).strip()
    items = []
    if body:
        items = [line.rstrip().rstrip(',') for line in body.splitlines() if line.strip()]
    quoted = f'"{name}"'
    if quoted not in items and f"'{name}'" not in items:
        items.append(quoted)
    item_indent = indent + '    '
    new_body = '\n' + '\n'.join(f'{item_indent}{item},' for item in items)
    if items:
        new_body = new_body.rstrip(',')
    new_body += f'\n{indent}'
    replacement = m.group(1) + new_body + m.group(4)
    text = text[:m.start()] + replacement + text[m.end():]
else:
    text = text.rstrip() + f'\n\nscripts: [\n    "{name}"\n]\n'

path.write_text(text, 'utf-8')
print('CONFIG_UPDATED')
PY

# Commands executed through Docker use root by default. BlueMap, however,
# runs as the `crafty` user. If the installer creates the
# web root as root while BlueMap is still starting, the mod cannot
# generate maps/, lang/, or update the web files. Normalize permissions before
# and after copying the bridge to avoid that startup race.
docker exec "$CRAFTY_CONTAINER" sh -lc "
  set -eu
  for path in '$WEBAPP_CONFIG' '${WEBSERVER_CONFIG:-}'; do
    [ -n \"\$path\" ] || continue
    [ -e \"\$path\" ] || continue
    chown crafty:root \"\$path\" 2>/dev/null || true
    chmod 0664 \"\$path\" 2>/dev/null || true
  done
"

for WEBROOT in "${WEBROOTS[@]}"; do
  docker exec "$CRAFTY_CONTAINER" sh -lc "
    set -eu
    mkdir -p '$WEBROOT'
    chown -R crafty:root '$WEBROOT' 2>/dev/null || true
    find '$WEBROOT' -type d -exec chmod 0775 {} + 2>/dev/null || true
    find '$WEBROOT' -type f -exec chmod 0664 {} + 2>/dev/null || true
  "
  if docker exec "$CRAFTY_CONTAINER" test -f "$WEBROOT/$BRIDGE_NAME"; then
    docker exec "$CRAFTY_CONTAINER" cp -p "$WEBROOT/$BRIDGE_NAME" "$WEBROOT/$BRIDGE_NAME.pre-$STAMP"
  fi
  docker cp "$BRIDGE_FILE" "$CRAFTY_CONTAINER:$WEBROOT/$BRIDGE_NAME" >/dev/null
  docker exec "$CRAFTY_CONTAINER" sh -lc "chown crafty:root '$WEBROOT/$BRIDGE_NAME' 2>/dev/null || true; chmod 0664 '$WEBROOT/$BRIDGE_NAME'"

  if docker exec "$CRAFTY_CONTAINER" test -f "$WEBROOT/index.html"; then
    docker exec "$CRAFTY_CONTAINER" cp -p "$WEBROOT/index.html" "$WEBROOT/index.html.pre-player-panel-v6-$STAMP"
    docker exec -i "$CRAFTY_CONTAINER" python3 - "$WEBROOT/index.html" "$BRIDGE_NAME" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
name = sys.argv[2]
text = path.read_text('utf-8', errors='replace')
start = '<!-- player-panel-bluemap-bridge:start -->'
end = '<!-- player-panel-bluemap-bridge:end -->'
text = re.sub(re.escape(start) + r'.*?' + re.escape(end), '', text, flags=re.S)
# Remove a possible old unmarked tag.
text = re.sub(r'\s*<script[^>]+src=["\'][^"\']*player-panel-bluemap-bridge(?:-v[0-9]+)?\.js[^"\']*["\'][^>]*></script>\s*', '\n', text, flags=re.I)
tag = f'{start}\n<script defer src="{name}?v=6"></script>\n{end}'
if re.search(r'</body\s*>', text, flags=re.I):
    text = re.sub(r'</body\s*>', tag + '\n</body>', text, count=1, flags=re.I)
else:
    text = text.rstrip() + '\n' + tag + '\n'
path.write_text(text, 'utf-8')
print('INDEX_PATCHED')
PY
  else
    echo "[AVISO] $WEBROOT/index.html does not exist; BlueMap must generate it with reload light."
  fi

  docker exec "$CRAFTY_CONTAINER" sh -lc "
    set -eu
    chown -R crafty:root '$WEBROOT' 2>/dev/null || true
    find '$WEBROOT' -type d -exec chmod 0775 {} + 2>/dev/null || true
    find '$WEBROOT' -type f -exec chmod 0664 {} + 2>/dev/null || true
  "

done

echo
echo "=== VERIFICATION ==="
docker exec "$CRAFTY_CONTAINER" sh -c "grep -n -A8 -B2 'scripts' '$WEBAPP_CONFIG' | head -40" || true
for WEBROOT in "${WEBROOTS[@]}"; do
  docker exec "$CRAFTY_CONTAINER" sh -c "ls -l '$WEBROOT/$BRIDGE_NAME'; grep -n 'player-panel-bluemap-bridge' '$WEBROOT/index.html' 2>/dev/null || true"
done

echo
echo "[OK] BlueMap bridge v6 installed."
echo "1. Run /bluemap reload light in the server console."
echo "2. Reload BlueMap with Ctrl+F5."
echo "3. Open Teleport Locations → Choose in BlueMap again."
echo "The status should change to 'BlueMap bridge connected'."
