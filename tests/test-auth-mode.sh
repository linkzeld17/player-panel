#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT/components/web/app/server.py" <<'PY'
from __future__ import annotations

import ast
import hashlib
import sys
from pathlib import Path

path = Path(sys.argv[1])
tree = ast.parse(path.read_text('utf-8'))
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == 'offline_player_uuid'
)
module = ast.Module(body=[function], type_ignores=[])
ast.fix_missing_locations(module)
namespace = {'hashlib': hashlib}
exec(compile(module, str(path), 'exec'), namespace)
calculate = namespace['offline_player_uuid']
expected = {
    'PlayerOne': '9fcfeca6-a915-30ca-b4d5-90473e8e3017',
    'TestUser': '097d3392-865a-3f3c-8b4a-da1c3473466c',
    'Steve': '5627dd98-e6be-3c21-b8a8-e92344183641',
}
for name, value in expected.items():
    actual = calculate(name)
    if actual != value:
        raise SystemExit(f'{name}: {actual} != {value}')
if calculate('PlayerOne') == calculate('playerone'):
    raise SystemExit('Capitalization must change the offline UUID')
print('PLAYER_PANEL_OFFLINE_UUID_TEST_OK')
PY

grep -q 'MINECRAFT_AUTH_MODE' "$ROOT/components/web/docker-compose.yml"
grep -q 'data\["uuid"\] = offline_player_uuid(player_name_value)' "$ROOT/components/web/app/server.py"
grep -q 'white-list.*true' "$ROOT/install.sh"
grep -q 'enforce-whitelist.*true' "$ROOT/install.sh"
grep -q 'auth-repair-' "$ROOT/repair-server.sh"
grep -q 'chown -R crafty:root' "$ROOT/scripts/maps/install-bluemap-bridge.sh"

echo PLAYER_PANEL_AUTH_MODE_TEST_OK
