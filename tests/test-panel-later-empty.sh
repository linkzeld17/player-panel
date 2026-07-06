#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DATA_ROOT="$TMP/data" \
ADMIN_PASSWORD='TestPassword123!' \
SESSION_SECRET='1234567890123456789012345678901234567890' \
PLAYER_PANEL_SETUP_MODE='later' \
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
assert server.list_server_profiles_public() == []
assert server.default_server_id() == 0
assert server.current_server_id() == 0
flags = server.connection_flags_public()
assert flags == {
    "plugin": {"configured": False},
    "crafty": {"configured": False},
    "blueMap": {"configured": False},
    "squareMap": {"configured": False},
}
assert server.onboarding_state()["required"] is True

profile = server.save_server_profile({
    "name": "Remote server",
    "isDefault": False,
    "sourceType": "manual",
    "plugin": {
        "enabled": True,
        "apiUrl": "https://plugin.example.test",
        "apiToken": "x" * 40,
        "verifyTls": True,
    },
    "crafty": {"enabled": False, "connectionId": 0, "serverId": ""},
    "blueMap": {"enabled": False, "url": "", "mapId": ""},
    "squareMap": {
        "enabled": True,
        "url": "https://map2d.example.test",
        "worldId": "minecraft:overworld",
    },
})
assert profile["isDefault"] is True
assert profile["squareMap"]["configured"] is True
assert server.default_server_id() == profile["id"]
assert len(server.list_server_profiles_public()) == 1
print("PLAYER_PANEL_LATER_EMPTY_TEST_OK")
PY
