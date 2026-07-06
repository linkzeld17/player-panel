#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ROOT="$ROOT" TMP="$TMP" python3 - <<'PY'
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import types
from email.message import Message
from pathlib import Path

root = Path(os.environ['ROOT'])
tmp = Path(os.environ['TMP'])
sys.dont_write_bytecode = True

stub = types.ModuleType('pywebpush')
class WebPushException(Exception):
    pass
stub.WebPushException = WebPushException
stub.webpush = lambda **kwargs: None
sys.modules['pywebpush'] = stub

os.environ.update({
    'ADMIN_PASSWORD': 'StrongTestPassword-123',
    'SESSION_SECRET': 'a' * 64,
    'DATA_ROOT': str(tmp / 'data'),
    'TRUST_PROXY': 'true',
    'TRUSTED_PROXY_CIDRS': '127.0.0.0/8,::1/128,172.20.0.0/16',
    'COOKIE_SECURE': 'false',
})

spec = importlib.util.spec_from_file_location('player_panel_server', root / 'components/web/app/server.py')
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


def handler(peer: str, headers: dict[str, str]):
    value = object.__new__(module.Handler)
    value.client_address = (peer, 12345)
    message = Message()
    for key, item in headers.items():
        message[key] = item
    value.headers = message
    return value

assert handler('172.20.0.1', {'X-Forwarded-For': '203.0.113.44, 172.20.0.1'}).client_ip() == '203.0.113.44'
assert handler('172.20.0.1', {'X-Real-IP': '198.51.100.18'}).client_ip() == '198.51.100.18'
assert handler('172.20.0.1', {'CF-Connecting-IP': '2001:db8::25'}).client_ip() == '2001:db8::25'
assert handler('172.20.0.1', {'Forwarded': 'for="[2001:db8::30]:443";proto=https'}).client_ip() == '2001:db8::30'
assert handler('198.51.100.7', {'X-Forwarded-For': '203.0.113.99'}).client_ip() == '198.51.100.7'
assert module.normalize_ip_address('::ffff:192.0.2.15') == '192.0.2.15'

module.init_db()
with module.db_connect() as db:
    user = db.execute("SELECT * FROM users WHERE username='admin'").fetchone()
assert user is not None
raw_token, _csrf = module.create_session(user, '172.20.0.1', 'test-agent')
session = module.validate_session(raw_token, '203.0.113.44')
assert session and session['ip'] == '203.0.113.44'
with module.db_connect() as db:
    stored = db.execute('SELECT ip FROM web_sessions WHERE token_hash=?', (session['token_hash'],)).fetchone()
assert stored and stored['ip'] == '203.0.113.44'

print('PLAYER_PANEL_PROXY_IP_TEST_OK')
PY
