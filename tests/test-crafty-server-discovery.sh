#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
UUID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
mkdir -p "$TMP/servers/$UUID" "$TMP/config"

python3 - "$TMP/config/crafty.sqlite" "$UUID" <<'PY'
import sqlite3, sys
path, sid = sys.argv[1:]
con = sqlite3.connect(path)
con.execute('CREATE TABLE servers (server_id TEXT PRIMARY KEY, server_name TEXT, type TEXT, executable TEXT, execution_command TEXT)')
con.execute('INSERT INTO servers VALUES (?, ?, ?, ?, ?)', (sid, 'H-MC', 'minecraft-java', 'fabric-server-launch.jar', 'java -jar fabric-server-launch.jar nogui'))
con.commit(); con.close()
PY

row="$(python3 "$ROOT/scripts/lib/crafty-server-discovery.py" --servers-root "$TMP/servers" --config-root "$TMP/config")"
[[ "$row" == "$UUID"$'\t''H-MC'$'\t''Fabric'$'\t''0' ]]

python3 - "$TMP/config/crafty.sqlite" "$UUID" <<'PY'
import sqlite3, sys
path, sid = sys.argv[1:]
con = sqlite3.connect(path)
con.execute('UPDATE servers SET executable=?, execution_command=? WHERE server_id=?', ('paper.jar', 'java -jar paper.jar nogui', sid))
con.commit(); con.close()
PY
row="$(python3 "$ROOT/scripts/lib/crafty-server-discovery.py" --servers-root "$TMP/servers" --config-root "$TMP/config")"
[[ "$row" == "$UUID"$'\t''H-MC'$'\t''Paper'$'\t''0' ]]

rm -f "$TMP/config/crafty.sqlite"
mkdir -p "$TMP/servers/$UUID/mods"
row="$(python3 "$ROOT/scripts/lib/crafty-server-discovery.py" --servers-root "$TMP/servers" --config-root "$TMP/config")"
[[ "$row" == "$UUID"$'\t''Server aaaaaaaa'$'\t''Fabric'$'\t''0' ]]

rm -rf "$TMP/servers/$UUID/mods"
row="$(python3 "$ROOT/scripts/lib/crafty-server-discovery.py" --servers-root "$TMP/servers" --config-root "$TMP/config")"
[[ "$row" == "$UUID"$'\t''Server aaaaaaaa'$'\t''Unknown'$'\t''0' ]]

echo PLAYER_PANEL_CRAFTY_SERVER_DISCOVERY_TEST_OK
