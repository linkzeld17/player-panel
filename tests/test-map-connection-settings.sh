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

import os
import sqlite3
import sys
import types

# The package test only exercises configuration persistence; push delivery is
# outside its scope, so provide the small import surface server.py expects.
pywebpush = types.ModuleType("pywebpush")
class WebPushException(Exception):
    pass
pywebpush.WebPushException = WebPushException
pywebpush.webpush = lambda *args, **kwargs: None
sys.modules["pywebpush"] = pywebpush

import server

server.init_db()
profile_id = server.current_server_id()

# Reproduce the RC10 regression: a legacy unrelated Crafty panel value lacks a
# scheme. Saving a valid map URL must not validate or overwrite this field.
with server.db_connect() as db:
    db.execute(
        "UPDATE server_profiles SET crafty_panel_url=?, crafty_enabled=0 WHERE id=?",
        ("crafty.example.test/panel", profile_id),
    )

blue = server.update_connection_settings({
    "type": "bluemap",
    "enabled": True,
    "url": "https://mcmap.example.test/",
    "mapId": "world",
})
assert blue["blueMap"]["configured"] is True
assert blue["blueMap"]["url"] == "https://mcmap.example.test"
assert blue["blueMap"]["mapId"] == "world"

square = server.update_connection_settings({
    "type": "squaremap",
    "enabled": True,
    "url": "https://map2d.example.test/",
    "worldId": "minecraft:overworld",
})
assert square["squareMap"]["configured"] is True
assert square["squareMap"]["url"] == "https://map2d.example.test"
assert square["squareMap"]["worldId"] == "minecraft:overworld"

with server.db_connect() as db:
    row = db.execute(
        "SELECT crafty_panel_url, bluemap_url, squaremap_url FROM server_profiles WHERE id=?",
        (profile_id,),
    ).fetchone()
assert row["crafty_panel_url"] == "crafty.example.test/panel"
assert row["bluemap_url"] == "https://mcmap.example.test"
assert row["squaremap_url"] == "https://map2d.example.test"

blue_bare = server.update_connection_settings({
    "type": "bluemap",
    "enabled": True,
    "url": "mcmap.example.test",
    "mapId": "world",
})
assert blue_bare["blueMap"]["url"] == "https://mcmap.example.test"

blue_ip = server.update_connection_settings({
    "type": "bluemap",
    "enabled": True,
    "url": "192.168.1.40:8100",
    "mapId": "world",
})
assert blue_ip["blueMap"]["url"] == "http://192.168.1.40:8100"

try:
    server.update_connection_settings({
        "type": "squaremap",
        "enabled": True,
        "url": "https://map2d.example.test/?world=world",
        "worldId": "minecraft:overworld",
    })
except ValueError as exc:
    assert str(exc) == "squaremap address must not contain query parameters or fragments"
else:
    raise AssertionError("A squaremap URL with query parameters should have been rejected")

print("PLAYER_PANEL_MAP_CONNECTION_SETTINGS_TEST_OK")
PY
