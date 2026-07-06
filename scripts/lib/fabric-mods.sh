#!/usr/bin/env bash

# Utilities for detecting, validating, downloading, and installing Fabric mods inside
# of a Crafty-managed server. This file is sourced from install.sh.

pp_fabric_mod_rows() {
  local container="$1" server_root="$2"
  docker exec -i "$container" python3 - "$server_root/mods" <<'PY'
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

mods_dir = Path(sys.argv[1])
if not mods_dir.is_dir():
    raise SystemExit(0)

fallbacks = {
    "fabric-api": re.compile(r"^fabric-api[-_].*\.jar$", re.I),
    "squaremap": re.compile(r"^squaremap(?:-fabric)?[-_].*\.jar$", re.I),
    "bluemap": re.compile(r"^bluemap[-_].*fabric.*\.jar$|^bluemap[-_].*\.jar$", re.I),
}

for jar in sorted(mods_dir.glob("*.jar")):
    mod_id = version = ""
    source = "metadata"
    try:
        with zipfile.ZipFile(jar) as archive:
            data = json.loads(archive.read("fabric.mod.json").decode("utf-8"))
        mod_id = str(data.get("id", "")).strip()
        raw_version = data.get("version", "")
        version = str(raw_version).strip()
    except Exception:
        source = "filename"
        for candidate, pattern in fallbacks.items():
            if pattern.match(jar.name):
                mod_id = candidate
                break
    if mod_id:
        clean_version = version.replace("\t", " ").replace("\n", " ")
        print(f"{mod_id}\t{clean_version}\t{jar}\t{source}")
PY
}

pp_fabric_mod_info() {
  local container="$1" server_root="$2" mod_id="$3"
  pp_fabric_mod_rows "$container" "$server_root" | awk -F '\t' -v id="$mod_id" '$1 == id {print; exit}'
}

pp_version_at_least() {
  local actual="$1" required="$2"
  python3 - "$actual" "$required" <<'PY'
import re
import sys

def numbers(value: str) -> tuple[int, ...]:
    core = re.split(r"[+-]", value.strip(), maxsplit=1)[0]
    result = tuple(int(part) for part in re.findall(r"\d+", core))
    return result or (0,)

a = numbers(sys.argv[1])
b = numbers(sys.argv[2])
size = max(len(a), len(b))
a += (0,) * (size - len(a))
b += (0,) * (size - len(b))
raise SystemExit(0 if a >= b else 1)
PY
}

pp_validate_fabric_jar() {
  local jar="$1" expected_id="$2" expected_version="${3:-}"
  python3 - "$jar" "$expected_id" "$expected_version" <<'PY'
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

jar = Path(sys.argv[1])
expected_id = sys.argv[2]
expected_version = sys.argv[3]

if not jar.is_file() or jar.stat().st_size == 0:
    raise SystemExit(f"Missing or empty JAR: {jar}")

try:
    with zipfile.ZipFile(jar) as archive:
        data = json.loads(archive.read("fabric.mod.json").decode("utf-8"))
except Exception as exc:
    raise SystemExit(f"Could not read fabric.mod.json from {jar.name}: {exc}")

mod_id = str(data.get("id", "")).strip()
version = str(data.get("version", "")).strip()
if mod_id != expected_id:
    raise SystemExit(f"The downloaded JAR declares id={mod_id!r}; expected {expected_id!r}")
if expected_version and version != expected_version:
    raise SystemExit(f"The downloaded JAR declares version {version!r}; expected {expected_version!r}")
print(f"{mod_id}\t{version}")
PY
}

pp_install_fabric_mod() {
  local container="$1" server_root="$2" label="$3" mod_id="$4"
  local expected_version="$5" filename="$6" url="$7" expected_sha256="${8:-}"
  local tmp stamp backup downloaded_info installed_info installed_version installed_path installed_source

  tmp="$(mktemp -d)"
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="$server_root/player-panel-backups/mods-$stamp"
  trap 'rm -rf "${tmp:-}"' RETURN

  pp_log "Downloading $label $expected_version from its official release..."
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    -A "player-panel-installer/1.0" "$url" -o "$tmp/$filename"

  if [[ -n "$expected_sha256" ]]; then
    printf '%s  %s\n' "$expected_sha256" "$tmp/$filename" | sha256sum -c -
  fi
  downloaded_info="$(pp_validate_fabric_jar "$tmp/$filename" "$mod_id" "$expected_version")"
  pp_ok "JAR validado: ${downloaded_info//$'\t'/ }"

  docker exec "$container" sh -lc "mkdir -p '$server_root/mods' '$backup'"

  while IFS=$'\t' read -r _ installed_version installed_path installed_source; do
    [[ -n "$installed_path" ]] || continue
    pp_warn "Backing up the previous version of $label: $installed_path"
    docker exec "$container" sh -lc "mv -- '$installed_path' '$backup/'"
  done < <(pp_fabric_mod_rows "$container" "$server_root" | awk -F '\t' -v id="$mod_id" '$1 == id')

  docker cp "$tmp/$filename" "$container:$server_root/mods/$filename"
  docker exec "$container" sh -lc "set -eu; test -s '$server_root/mods/$filename'; chown crafty:root '$server_root/mods/$filename' 2>/dev/null || true; chmod 0644 '$server_root/mods/$filename'"

  installed_info="$(pp_fabric_mod_info "$container" "$server_root" "$mod_id" || true)"
  [[ -n "$installed_info" ]] || pp_fail "$label was copied but could not be detected by its Fabric identifier '$mod_id'."
  IFS=$'\t' read -r _ installed_version installed_path installed_source <<<"$installed_info"
  [[ "$installed_version" == "$expected_version" ]] || pp_fail "$label was left at version '$installed_version' instead of '$expected_version'."
  pp_ok "$label $installed_version installed at $installed_path."

  rm -rf "$tmp"
  trap - RETURN
}
