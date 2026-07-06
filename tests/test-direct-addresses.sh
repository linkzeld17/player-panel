#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DATA_ROOT="$TMP/data" \
ADMIN_PASSWORD='TestPassword123!' \
SESSION_SECRET='1234567890123456789012345678901234567890' \
PYTHONPYCACHEPREFIX="$TMP/pycache" \
PYTHONPATH="$ROOT/components/web/app" \
python3 - <<'PY'
from __future__ import annotations

import sys
import types

pywebpush = types.ModuleType("pywebpush")
class WebPushException(Exception):
    pass
pywebpush.WebPushException = WebPushException
pywebpush.webpush = lambda *args, **kwargs: None
sys.modules["pywebpush"] = pywebpush

import server

server.init_db()
plugin = server.update_connection_settings({
    "type": "plugin",
    "enabled": True,
    "apiUrl": "192.168.1.50",
    "apiToken": "a" * 32,
    "verifyTls": False,
})
assert plugin["plugin"]["apiUrl"] == "http://192.168.1.50:8765"

crafty = server.save_crafty_connection({
    "name": "Crafty LAN",
    "apiUrl": "10.0.0.20",
    "apiToken": "b" * 32,
    "verifyTls": False,
})
assert crafty["apiUrl"] == "https://10.0.0.20:8443"

crafty_domain = server.save_crafty_connection({
    "name": "Crafty dominio",
    "apiUrl": "crafty.example.test",
    "apiToken": "c" * 32,
    "verifyTls": True,
})
assert crafty_domain["apiUrl"] == "https://crafty.example.test"

blue = server.update_connection_settings({
    "type": "bluemap",
    "enabled": True,
    "url": "192.168.1.50:8100",
    "mapId": "world",
})
assert blue["blueMap"]["url"] == "http://192.168.1.50:8100"

square = server.update_connection_settings({
    "type": "squaremap",
    "enabled": True,
    "url": "192.168.1.50:8110",
    "worldId": "minecraft:overworld",
})
assert square["squareMap"]["url"] == "http://192.168.1.50:8110"

print("PLAYER_PANEL_DIRECT_ADDRESSES_TEST_OK")
PY
