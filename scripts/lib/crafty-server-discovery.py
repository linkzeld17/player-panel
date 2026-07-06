#!/usr/bin/env python3
"""Discover Crafty servers and classify their platform using the database and files."""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
from pathlib import Path
from typing import Iterable

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
TYPE_COLUMNS = (
    "server_type",
    "server_software",
    "software",
    "server_kind",
    "type",
    "server_jar",
    "server_executable",
    "executable",
    "jar",
    "jarfile",
    "execution_command",
    "exec_command",
    "run_command",
    "startup_command",
)
NAME_COLUMNS = ("server_name", "display_name", "name")
ID_COLUMNS = ("server_id", "server_uuid", "uuid")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--servers-root", default="/crafty/servers")
    parser.add_argument(
        "--config-root",
        action="append",
        dest="config_roots",
        default=None,
        help="May be repeated. By default, checks /crafty/app/config and /crafty/config.",
    )
    return parser.parse_args()


def database_files(config_roots: Iterable[Path]) -> Iterable[Path]:
    for config_root in config_roots:
        if not config_root.exists():
            continue
        for current, dirs, files in os.walk(config_root):
            try:
                if len(Path(current).relative_to(config_root).parts) >= 5:
                    dirs[:] = []
            except (OSError, ValueError):
                pass
            for filename in files:
                if filename.lower().endswith((".db", ".sqlite", ".sqlite3")):
                    yield Path(current) / filename


def read_database_metadata(
    server_ids: set[str], config_roots: Iterable[Path]
) -> tuple[dict[str, str], dict[str, list[str]]]:
    names: dict[str, str] = {}
    hints: dict[str, list[str]] = {server_id: [] for server_id in server_ids}

    for path in database_files(config_roots):
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            for (table,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ):
                safe_table = str(table).replace('"', '""')
                columns = [
                    row[1]
                    for row in connection.execute(
                        f'PRAGMA table_info("{safe_table}")'
                    )
                ]
                lower = {column.lower(): column for column in columns}
                id_column = next(
                    (lower[key] for key in ID_COLUMNS if key in lower), None
                )
                if not id_column:
                    continue
                name_column = next(
                    (lower[key] for key in NAME_COLUMNS if key in lower), None
                )
                hint_columns: list[str] = []
                for key in TYPE_COLUMNS:
                    column = lower.get(key)
                    if column and column != id_column and column not in hint_columns:
                        hint_columns.append(column)

                selected = [id_column]
                if name_column and name_column not in selected:
                    selected.append(name_column)
                selected.extend(
                    column for column in hint_columns if column not in selected
                )
                query_columns = ", ".join(f'"{column}"' for column in selected)

                try:
                    rows = connection.execute(
                        f'SELECT {query_columns} FROM "{safe_table}"'
                    )
                except sqlite3.Error:
                    continue

                for row in rows:
                    values = dict(zip(selected, row))
                    server_id = str(values.get(id_column) or "").strip()
                    if server_id not in hints:
                        continue
                    if name_column:
                        name = str(values.get(name_column) or "").strip()
                        if name:
                            names[server_id] = name
                    for column in hint_columns:
                        value = str(values.get(column) or "").strip()
                        if value:
                            hints[server_id].append(value)
        except sqlite3.Error:
            pass
        finally:
            connection.close()

    return names, hints


def process_uses_directory(path: Path) -> bool:
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return False
    for process in proc_root.iterdir():
        if not process.name.isdigit():
            continue
        try:
            if Path(os.readlink(process / "cwd")) == path:
                return True
        except OSError:
            pass
    return False


def contains_any(text: str, words: Iterable[str]) -> bool:
    return any(word in text for word in words)


def classify_server(base: Path, database_hints: Iterable[str]) -> str:
    database_text = " ".join(database_hints).lower()
    if "fabric" in database_text:
        return "Fabric"
    if contains_any(database_text, ("paper", "purpur", "spigot", "bukkit")):
        return "Paper"
    if contains_any(
        database_text, ("forge", "neoforge", "quilt", "vanilla", "bedrock")
    ):
        return "Otro"

    if (base / "mods").is_dir():
        return "Fabric"
    if (base / ".fabric").exists() or (
        base / "libraries" / "net" / "fabricmc"
    ).exists():
        return "Fabric"
    try:
        for child in base.iterdir():
            filename = child.name.lower()
            if child.is_file() and filename.endswith(".jar") and "fabric" in filename:
                return "Fabric"
    except OSError:
        pass

    if (base / "plugins").is_dir():
        return "Paper"
    try:
        for child in base.iterdir():
            filename = child.name.lower()
            if (
                child.is_file()
                and filename.endswith(".jar")
                and contains_any(filename, ("paper", "purpur", "spigot"))
            ):
                return "Paper"
    except OSError:
        pass

    return "Unknown"


def main() -> int:
    args = parse_args()
    servers_root = Path(args.servers_root)
    config_roots = [
        Path(path)
        for path in (
            args.config_roots
            if args.config_roots is not None
            else ("/crafty/app/config", "/crafty/config")
        )
    ]

    server_ids = sorted(
        path.name
        for path in servers_root.iterdir()
        if path.is_dir() and UUID_RE.fullmatch(path.name)
    ) if servers_root.is_dir() else []

    names, hints = read_database_metadata(set(server_ids), config_roots)
    for server_id in server_ids:
        base = servers_root / server_id
        kind = classify_server(base, hints.get(server_id, []))
        name = names.get(server_id, f"Server {server_id[:8]}")
        name = name.replace("\t", " ").replace("\n", " ")
        running = 1 if process_uses_directory(base) else 0
        print(f"{server_id}\t{name}\t{kind}\t{running}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
