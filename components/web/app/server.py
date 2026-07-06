#!/usr/bin/env python3
"""PlayerPanel Web: dependency-free admin UI, API proxy and local dashboard database."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import mimetypes
import os
import platform
import queue
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse
from xml.sax.saxutils import escape as xml_escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

APP_VERSION = "1.10.19"
APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
DATA_ROOT = Path(os.getenv("DATA_ROOT", "/data"))
DB_PATH = DATA_ROOT / "player-panel.db"
BACKUP_ROOT = DATA_ROOT / "backups"
APP_STARTED_AT = int(time.time())
MAINTENANCE_MODE = threading.Event()
MAINTENANCE_LOCK = threading.RLock()
ALERT_LOCK = threading.RLock()
MEDIA_CACHE_ROOT = Path(os.getenv("MEDIA_CACHE_ROOT", "/tmp/player-panel-media"))
MINECRAFT_ASSET_VERSION = os.getenv("MINECRAFT_ASSET_VERSION", "26.1.2").strip() or "26.1.2"
MINECRAFT_AUTH_MODE = os.getenv("MINECRAFT_AUTH_MODE", "online").strip().lower()
if MINECRAFT_AUTH_MODE not in {"online", "offline"}:
    MINECRAFT_AUTH_MODE = "online"
MEDIA_TIMEOUT = float(os.getenv("MEDIA_TIMEOUT_SECONDS", "5"))
MEDIA_CACHE_TTL = int(os.getenv("MEDIA_CACHE_TTL_SECONDS", "604800"))
MONITOR_INTERVAL = max(3, int(os.getenv("MONITOR_INTERVAL_SECONDS", "5")))
API_DOWN_FAILURE_THRESHOLD = max(2, int(os.getenv("API_DOWN_FAILURE_THRESHOLD", "3")))
API_DOWN_GRACE_SECONDS = max(MONITOR_INTERVAL, int(os.getenv("API_DOWN_GRACE_SECONDS", "10")))
PLUGIN_EVENT_INTERVAL = max(1, int(os.getenv("PLUGIN_EVENT_INTERVAL_SECONDS", "1")))
LIVE_EVENT_HEARTBEAT_SECONDS = max(5, int(os.getenv("LIVE_EVENT_HEARTBEAT_SECONDS", "15")))
METRICS_SAMPLE_INTERVAL = max(30, int(os.getenv("METRICS_SAMPLE_INTERVAL_SECONDS", "60")))
METRICS_RETENTION_DAYS = min(max(1, int(os.getenv("METRICS_RETENTION_DAYS", "30"))), 365)
LOW_FOOD_THRESHOLD = int(os.getenv("LOW_FOOD_THRESHOLD", "6"))
VAPID_PRIVATE_KEY_PATH = DATA_ROOT / "vapid_private.pem"
DEFAULT_VAPID_SUBJECT = "mailto:admin@example.com"
DEFAULT_TIMEZONE = os.getenv("TZ", "UTC").strip() or "UTC"
_raw_vapid_subject = os.getenv("VAPID_SUBJECT", DEFAULT_VAPID_SUBJECT).strip()
# Apple requires the VAPID subject to be to valid https: or mailto: URI.
# Older packages used an example.invalid address; normalize it to the public panel URL.
VAPID_SUBJECT = (
    DEFAULT_VAPID_SUBJECT
    if not _raw_vapid_subject
    or _raw_vapid_subject == "mailto:admin@example.invalid"
    or not _raw_vapid_subject.startswith(("https://", "mailto:"))
    else _raw_vapid_subject
)
PUSH_TTL = max(60, int(os.getenv("PUSH_TTL_SECONDS", "3600")))
PUSH_TIMEOUT = max(2.0, float(os.getenv("PUSH_TIMEOUT_SECONDS", "10")))
PUSH_EVENT_TYPES = {
    "join", "leave", "death", "low_food", "server_down", "server_up",
    "weather", "backup_requested", "server_action", "high_cpu", "high_memory",
    "low_tps", "high_storage", "metrics_recovered",
    "crafty_down", "crafty_up", "whitelist_denied", "test"
}
PUSH_DEFAULT_EVENTS = {
    "join", "leave", "death", "server_down", "server_up", "backup_requested",
    "whitelist_denied"
}

DATA_ROOT.mkdir(parents=True, exist_ok=True)
BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
MEDIA_CACHE_ROOT.mkdir(parents=True, exist_ok=True)


def read_secret(env_name: str, file_env_name: str, default: str = "") -> str:
    file_path = os.getenv(file_env_name, "").strip()
    if file_path:
        try:
            return Path(file_path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RuntimeError(f"Cannot read secret file {file_path}: {exc}") from exc
    return os.getenv(env_name, default).strip()


def offline_player_uuid(name: str) -> str:
    """Return the UUID used by an offline-mode Minecraft server for an exact player name."""
    raw = bytearray(hashlib.md5(("OfflinePlayer:" + name).encode("utf-8")).digest())
    raw[6] = (raw[6] & 0x0F) | 0x30
    raw[8] = (raw[8] & 0x3F) | 0x80
    import uuid as uuid_module
    return str(uuid_module.UUID(bytes=bytes(raw)))


API_URL = os.getenv("PLAYER_PANEL_API_URL", "http://crafty-controller:8765").rstrip("/")
API_TOKEN = read_secret("PLAYER_PANEL_API_TOKEN", "PLAYER_PANEL_API_TOKEN_FILE")
ADMIN_PASSWORD = read_secret("ADMIN_PASSWORD", "ADMIN_PASSWORD_FILE")
SESSION_SECRET = read_secret("SESSION_SECRET", "SESSION_SECRET_FILE")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() in {"1", "true", "yes", "on"}
SESSION_TTL = int(os.getenv("SESSION_TTL_SECONDS", "43200"))
LISTEN_HOST = os.getenv("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.getenv("LISTEN_PORT", "8080"))
UPSTREAM_TIMEOUT = float(os.getenv("UPSTREAM_TIMEOUT_SECONDS", "5"))
TRUST_PROXY = os.getenv("TRUST_PROXY", "false").lower() in {"1", "true", "yes", "on"}
TRUSTED_PROXY_CIDRS_RAW = os.getenv("TRUSTED_PROXY_CIDRS", "").strip()

def parse_trusted_proxy_networks(value: str) -> tuple[ipaddress._BaseNetwork, ...]:
    networks: list[ipaddress._BaseNetwork] = []
    for raw in re.split(r"[\s,;]+", value.strip()):
        if not raw:
            continue
        try:
            networks.append(ipaddress.ip_network(raw, strict=False))
        except ValueError:
            logging.getLogger("player-panel-web").warning("Ignoring invalid TRUSTED_PROXY_CIDRS entry: %s", raw)
    return tuple(networks)


TRUSTED_PROXY_NETWORKS = parse_trusted_proxy_networks(TRUSTED_PROXY_CIDRS_RAW)
DOCKER_HOST_GATEWAY_NAME = os.getenv("DOCKER_HOST_GATEWAY_NAME", "host.docker.internal").strip() or "host.docker.internal"

CRAFTY_API_URL = os.getenv("CRAFTY_API_URL", "https://crafty-controller:8443").rstrip("/")
CRAFTY_USERNAME = read_secret("CRAFTY_USERNAME", "CRAFTY_USERNAME_FILE")
CRAFTY_PASSWORD = read_secret("CRAFTY_PASSWORD", "CRAFTY_PASSWORD_FILE")
# Kept only as an optional migration fallback. Username/password login is preferred.
CRAFTY_API_TOKEN = read_secret("CRAFTY_API_TOKEN", "CRAFTY_API_TOKEN_FILE")
CRAFTY_SERVER_ID = os.getenv("CRAFTY_SERVER_ID", "").strip()
CRAFTY_PANEL_URL = os.getenv("CRAFTY_PANEL_URL", "").strip()
CRAFTY_VERIFY_TLS = os.getenv("CRAFTY_VERIFY_TLS", "false").lower() in {"1", "true", "yes", "on"}
CRAFTY_TIMEOUT = float(os.getenv("CRAFTY_TIMEOUT_SECONDS", "7"))
CRAFTY_LOG_LIMIT = min(max(int(os.getenv("CRAFTY_LOG_LIMIT", "160")), 20), 500)
CRAFTY_SUMMARY_CACHE_SECONDS = max(2.0, float(os.getenv("CRAFTY_SUMMARY_CACHE_SECONDS", "3")))
CRAFTY_SERVER_CACHE_SECONDS = max(15.0, float(os.getenv("CRAFTY_SERVER_CACHE_SECONDS", "60")))
CRAFTY_STALE_GRACE_SECONDS = max(15.0, float(os.getenv("CRAFTY_STALE_GRACE_SECONDS", "45")))

ENV_API_URL = API_URL
ENV_API_TOKEN = API_TOKEN
ENV_CRAFTY_API_URL = CRAFTY_API_URL
ENV_CRAFTY_USERNAME = CRAFTY_USERNAME
ENV_CRAFTY_PASSWORD = CRAFTY_PASSWORD
ENV_CRAFTY_API_TOKEN = CRAFTY_API_TOKEN
ENV_CRAFTY_SERVER_ID = CRAFTY_SERVER_ID
ENV_CRAFTY_PANEL_URL = CRAFTY_PANEL_URL
ENV_CRAFTY_VERIFY_TLS = CRAFTY_VERIFY_TLS
ENV_SQUAREMAP_URL = os.getenv("PLAYER_PANEL_SQUAREMAP_URL", "").strip().rstrip("/")
ENV_SQUAREMAP_WORLD_ID = os.getenv("PLAYER_PANEL_SQUAREMAP_WORLD_ID", "minecraft:overworld").strip() or "minecraft:overworld"
PANEL_SETUP_MODE = os.getenv("PLAYER_PANEL_SETUP_MODE", "choose").strip().lower()
if PANEL_SETUP_MODE not in {"choose", "manual", "crafty", "later"}:
    PANEL_SETUP_MODE = "choose"
PLUGIN_CONNECTION_ENABLED = bool(API_URL and API_TOKEN)
CRAFTY_CONNECTION_ENABLED = bool(CRAFTY_SERVER_ID and (CRAFTY_API_TOKEN or (CRAFTY_USERNAME and CRAFTY_PASSWORD)))
CONNECTION_CIPHER = Fernet(base64.urlsafe_b64encode(hashlib.sha256(("player-panel-connections:" + SESSION_SECRET).encode("utf-8")).digest()))

if not ADMIN_PASSWORD:
    raise RuntimeError("ADMIN_PASSWORD or ADMIN_PASSWORD_FILE is required")
if len(ADMIN_PASSWORD) < 10:
    raise RuntimeError("The admin password must contain at least 10 characters")
if len(SESSION_SECRET) < 32:
    raise RuntimeError("SESSION_SECRET must contain at least 32 characters")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("player-panel-web")

LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_ATTEMPTS = 8
PASSWORD_ROUNDS = 310_000
USER_LOCK_SECONDS = 600
USER_MAX_ATTEMPTS = 5

ROLE_PERMISSIONS: dict[str, set[str]] = {
    "admin": {"*"},
    "moderator": {
        "dashboard.view", "players.view", "inventory.view", "history.view", "sessions.view",
        "places.view", "places.manage", "alerts.view", "alerts.manage", "world.view", "world.control",
        "metrics.view",
        "players.heal", "players.feed", "players.gamemode", "players.teleport", "players.kick",
        "players.ban", "players.whitelist", "bulk.manage", "crafty.view", "crafty.logs",
    },
    "viewer": {
        "dashboard.view", "players.view", "inventory.view", "history.view", "sessions.view",
        "places.view", "alerts.view", "world.view", "crafty.view", "crafty.logs", "metrics.view",
    },
}
ROLE_LABELS = {"admin": "Administrator", "moderator": "Moderator", "viewer": "Read only"}
ALL_PERMISSIONS = sorted(set().union(*(perms for perms in ROLE_PERMISSIONS.values() if "*" not in perms)) | {
    "users.manage", "server.control", "server.backup", "players.clear_inventory", "players.operator", "metrics.manage",
    "system.view", "system.maintain", "system.backup", "system.restore", "system.settings"
})

ALLOWED_GET = [
    re.compile(r"^/api/v1/health$"),
    re.compile(r"^/api/v1/server$"),
    re.compile(r"^/api/v1/players$"),
    re.compile(r"^/api/v1/players/all$"),
    re.compile(r"^/api/v1/whitelist$"),
    re.compile(r"^/api/v1/bans$"),
    re.compile(r"^/api/v1/events$"),
    re.compile(r"^/api/v1/players/[0-9a-fA-F-]{36}$"),
    re.compile(r"^/api/v1/players/[0-9a-fA-F-]{36}/inventory$"),
]
ALLOWED_POST = [
    re.compile(r"^/api/v1/players/[0-9a-fA-F-]{36}/(?:heal|feed|gamemode|teleport|kick|ban|unban|whitelist|operator|clear-inventory)$"),
    re.compile(r"^/api/v1/whitelist/add$"),
    re.compile(r"^/api/v1/whitelist/update$"),
    re.compile(r"^/api/v1/world/control$"),
    re.compile(r"^/api/v1/world/safe-position$"),
]
BULK_ACTIONS = {"heal", "feed", "gamemode", "teleport", "kick"}

DASHBOARD_WIDGET_IDS = (
    "world", "online", "unread-alerts", "attention", "sessions", "actions",
    "plugin-metrics", "cpu", "memory", "tps", "uptime", "alerts", "online-players", "recent-sessions",
)
DASHBOARD_WIDGET_ID_SET = set(DASHBOARD_WIDGET_IDS)
DASHBOARD_OPTIONAL_WIDGET_IDS = ("cpu", "memory", "tps", "uptime")
DASHBOARD_WIDGET_KINDS = {
    "world": "world",
    "online": "stat", "unread-alerts": "stat", "attention": "stat", "sessions": "stat",
    "actions": "stat", "plugin-metrics": "stat",
    "cpu": "stat", "memory": "stat", "tps": "stat", "uptime": "stat",
    "alerts": "panel", "online-players": "panel", "recent-sessions": "panel",
}
DASHBOARD_DEFAULT_SIZES = {
    widget_id: {
        "cols": 12 if DASHBOARD_WIDGET_KINDS[widget_id] == "world" else 6 if DASHBOARD_WIDGET_KINDS[widget_id] == "panel" else 2,
        "height": 0,
    }
    for widget_id in DASHBOARD_WIDGET_IDS
}


def now_ts() -> int:
    return int(time.time())


def iso_time(timestamp: int | float | None = None) -> str:
    return datetime.fromtimestamp(timestamp or time.time(), tz=timezone.utc).isoformat()


def db_connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def init_db() -> None:
    with db_connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS server_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
                active INTEGER NOT NULL DEFAULT 1,
                is_default INTEGER NOT NULL DEFAULT 0,
                source_type TEXT NOT NULL DEFAULT 'manual',
                plugin_enabled INTEGER NOT NULL DEFAULT 1,
                plugin_api_url TEXT NOT NULL DEFAULT '',
                plugin_token TEXT NOT NULL DEFAULT '',
                plugin_verify_tls INTEGER NOT NULL DEFAULT 1,
                plugin_access_client_id TEXT NOT NULL DEFAULT '',
                plugin_access_client_secret TEXT NOT NULL DEFAULT '',
                crafty_enabled INTEGER NOT NULL DEFAULT 0,
                crafty_api_url TEXT NOT NULL DEFAULT '',
                crafty_username TEXT NOT NULL DEFAULT '',
                crafty_password TEXT NOT NULL DEFAULT '',
                crafty_api_token TEXT NOT NULL DEFAULT '',
                crafty_server_id TEXT NOT NULL DEFAULT '',
                crafty_panel_url TEXT NOT NULL DEFAULT '',
                crafty_verify_tls INTEGER NOT NULL DEFAULT 0,
                bluemap_enabled INTEGER NOT NULL DEFAULT 0,
                bluemap_url TEXT NOT NULL DEFAULT '',
                bluemap_map_id TEXT NOT NULL DEFAULT '',
                squaremap_enabled INTEGER NOT NULL DEFAULT 0,
                squaremap_url TEXT NOT NULL DEFAULT '',
                squaremap_world_id TEXT NOT NULL DEFAULT 'minecraft:overworld',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS server_profiles_active_idx ON server_profiles(active, is_default DESC, name);
            CREATE TABLE IF NOT EXISTS crafty_connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                active INTEGER NOT NULL DEFAULT 1,
                api_url TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                password TEXT NOT NULL DEFAULT '',
                api_token TEXT NOT NULL DEFAULT '',
                access_client_id TEXT NOT NULL DEFAULT '',
                access_client_secret TEXT NOT NULL DEFAULT '',
                panel_url TEXT NOT NULL DEFAULT '',
                verify_tls INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS crafty_connections_active_idx
                ON crafty_connections(active, name COLLATE NOCASE);
            CREATE TABLE IF NOT EXISTS places (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL COLLATE NOCASE,
                world TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                z REAL NOT NULL,
                yaw REAL NOT NULL DEFAULT 0,
                pitch REAL NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(server_id, name)
            );
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                category TEXT NOT NULL,
                action TEXT NOT NULL,
                actor TEXT NOT NULL DEFAULT 'admin',
                player_uuid TEXT,
                player_name TEXT,
                details TEXT,
                result TEXT NOT NULL,
                request_ip TEXT
            );
            CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit(ts DESC);
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                type TEXT NOT NULL,
                severity TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                player_uuid TEXT,
                is_read INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS alerts_ts_idx ON alerts(ts DESC);
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_uuid TEXT NOT NULL,
                player_name TEXT NOT NULL,
                joined_at INTEGER NOT NULL,
                left_at INTEGER,
                last_seen INTEGER NOT NULL,
                world TEXT,
                x REAL,
                y REAL,
                z REAL,
                health REAL,
                food INTEGER
            );
            CREATE INDEX IF NOT EXISTS sessions_player_idx ON sessions(player_uuid, joined_at DESC);
            CREATE INDEX IF NOT EXISTS sessions_open_idx ON sessions(left_at);
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                permissions_json TEXT NOT NULL DEFAULT '{}',
                active INTEGER NOT NULL DEFAULT 1,
                totp_secret TEXT,
                totp_enabled INTEGER NOT NULL DEFAULT 0,
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until INTEGER NOT NULL DEFAULT 0,
                session_version INTEGER NOT NULL DEFAULT 1,
                last_login INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS users_active_idx ON users(active, username);
            CREATE TABLE IF NOT EXISTS web_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                csrf TEXT NOT NULL,
                session_version INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                ip TEXT,
                user_agent TEXT
            );
            CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id, expires_at);
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                device_name TEXT NOT NULL DEFAULT 'Device',
                event_types_json TEXT NOT NULL DEFAULT '[]',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_success INTEGER,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id, enabled);
            CREATE TABLE IF NOT EXISTS metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                api_available INTEGER NOT NULL DEFAULT 0,
                crafty_available INTEGER NOT NULL DEFAULT 0,
                server_running INTEGER NOT NULL DEFAULT 0,
                online_players INTEGER NOT NULL DEFAULT 0,
                max_players INTEGER,
                cpu_percent REAL,
                memory_bytes INTEGER,
                memory_percent REAL,
                uptime_seconds INTEGER,
                tps_current REAL,
                storage_percent REAL,
                storage_free_bytes INTEGER,
                runtime_state TEXT
            );
            CREATE INDEX IF NOT EXISTS metrics_ts_idx ON metrics(ts DESC);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_preferences (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(user_id, key)
            );
            CREATE INDEX IF NOT EXISTS user_preferences_user_idx ON user_preferences(user_id, key);
            """
        )
        push_columns = {str(row["name"]) for row in db.execute("PRAGMA table_info(push_subscriptions)").fetchall()}
        if "vapid_key_id" not in push_columns:
            db.execute("ALTER TABLE push_subscriptions ADD COLUMN vapid_key_id TEXT")
        if "repair_required" not in push_columns:
            db.execute("ALTER TABLE push_subscriptions ADD COLUMN repair_required INTEGER NOT NULL DEFAULT 0")
        profile_columns = {str(row["name"]) for row in db.execute("PRAGMA table_info(server_profiles)").fetchall()}
        if "plugin_verify_tls" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN plugin_verify_tls INTEGER NOT NULL DEFAULT 1")
        if "plugin_access_client_id" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN plugin_access_client_id TEXT NOT NULL DEFAULT ''")
        if "plugin_access_client_secret" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN plugin_access_client_secret TEXT NOT NULL DEFAULT ''")
        crafty_connection_columns = {str(row["name"]) for row in db.execute("PRAGMA table_info(crafty_connections)").fetchall()}
        if "access_client_id" not in crafty_connection_columns:
            db.execute("ALTER TABLE crafty_connections ADD COLUMN access_client_id TEXT NOT NULL DEFAULT ''")
        if "access_client_secret" not in crafty_connection_columns:
            db.execute("ALTER TABLE crafty_connections ADD COLUMN access_client_secret TEXT NOT NULL DEFAULT ''")
        if "squaremap_enabled" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN squaremap_enabled INTEGER NOT NULL DEFAULT 0")
        if "squaremap_url" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN squaremap_url TEXT NOT NULL DEFAULT ''")
        if "squaremap_world_id" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN squaremap_world_id TEXT NOT NULL DEFAULT 'minecraft:overworld'")
        if "crafty_connection_id" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN crafty_connection_id INTEGER NOT NULL DEFAULT 0")
        if "source_type" not in profile_columns:
            db.execute("ALTER TABLE server_profiles ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'")
        db.execute(
            "UPDATE server_profiles SET source_type=CASE "
            "WHEN crafty_connection_id>0 OR crafty_enabled=1 OR TRIM(crafty_server_id)<>'' "
            "THEN 'crafty' ELSE 'manual' END "
            "WHERE source_type NOT IN ('crafty','manual') OR source_type='' "
            "OR (source_type='manual' AND (crafty_connection_id>0 OR crafty_enabled=1 OR TRIM(crafty_server_id)<>''))"
        )

        legacy_crafty_rows = db.execute(
            "SELECT id, crafty_api_url, crafty_username, crafty_password, "
            "crafty_api_token, crafty_panel_url, crafty_verify_tls "
            "FROM server_profiles "
            "WHERE crafty_connection_id=0 AND TRIM(crafty_api_url)<>'' "
            "AND (TRIM(crafty_api_token)<>'' OR "
            "(TRIM(crafty_username)<>'' AND TRIM(crafty_password)<>''))"
        ).fetchall()
        for legacy in legacy_crafty_rows:
            match = db.execute(
                "SELECT id FROM crafty_connections WHERE active=1 AND "
                "api_url=? AND username=? AND password=? AND api_token=? "
                "AND panel_url=? AND verify_tls=? ORDER BY id LIMIT 1",
                (
                    legacy["crafty_api_url"], legacy["crafty_username"],
                    legacy["crafty_password"], legacy["crafty_api_token"],
                    legacy["crafty_panel_url"], legacy["crafty_verify_tls"],
                ),
            ).fetchone()
            if match:
                connection_id = int(match["id"])
            else:
                base_name = "Crafty principal"
                candidate = base_name
                suffix = 2
                while db.execute(
                    "SELECT 1 FROM crafty_connections WHERE name=? COLLATE NOCASE",
                    (candidate,),
                ).fetchone():
                    candidate = f"{base_name} {suffix}"
                    suffix += 1
                cursor = db.execute(
                    "INSERT INTO crafty_connections("
                    "name, active, api_url, username, password, api_token, "
                    "panel_url, verify_tls, created_at, updated_at"
                    ") VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        candidate, 1, legacy["crafty_api_url"],
                        legacy["crafty_username"], legacy["crafty_password"],
                        legacy["crafty_api_token"], legacy["crafty_panel_url"],
                        legacy["crafty_verify_tls"], now_ts(), now_ts(),
                    ),
                )
                connection_id = int(cursor.lastrowid)
            db.execute(
                "UPDATE server_profiles SET crafty_connection_id=? WHERE id=?",
                (connection_id, int(legacy["id"])),
            )

        metric_columns = {str(row["name"]) for row in db.execute("PRAGMA table_info(metrics)").fetchall()}
        for column, definition in {
            "tps_current": "REAL",
            "storage_percent": "REAL",
            "storage_free_bytes": "INTEGER",
            "runtime_state": "TEXT",
        }.items():
            if column not in metric_columns:
                db.execute(f"ALTER TABLE metrics ADD COLUMN {column} {definition}")
        # Create the first server profile only when the installer supplied a
        # concrete connection path. "Configure later" must start with to truly
        # empty server list so the web add-server wizard owns the first-run flow.
        profile_count = int(db.execute("SELECT COUNT(*) FROM server_profiles").fetchone()[0])
        if profile_count == 0 and PANEL_SETUP_MODE != "later":
            timestamp = now_ts()
            plugin_token = "fernet:" + CONNECTION_CIPHER.encrypt(ENV_API_TOKEN.encode("utf-8")).decode("ascii") if ENV_API_TOKEN else ""
            crafty_password = "fernet:" + CONNECTION_CIPHER.encrypt(ENV_CRAFTY_PASSWORD.encode("utf-8")).decode("ascii") if ENV_CRAFTY_PASSWORD else ""
            crafty_token = "fernet:" + CONNECTION_CIPHER.encrypt(ENV_CRAFTY_API_TOKEN.encode("utf-8")).decode("ascii") if ENV_CRAFTY_API_TOKEN else ""
            profile_cursor = db.execute(
                "INSERT INTO server_profiles(name, slug, active, is_default, plugin_enabled, plugin_api_url, plugin_token, plugin_verify_tls, crafty_enabled, crafty_api_url, crafty_username, crafty_password, crafty_api_token, crafty_server_id, crafty_panel_url, crafty_verify_tls, squaremap_enabled, squaremap_url, squaremap_world_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "Primary server", "principal", 1, 1,
                    1 if bool(ENV_API_URL and ENV_API_TOKEN) else 0, ENV_API_URL, plugin_token, 1,
                    1 if bool(ENV_CRAFTY_SERVER_ID and (ENV_CRAFTY_API_TOKEN or (ENV_CRAFTY_USERNAME and ENV_CRAFTY_PASSWORD))) else 0,
                    ENV_CRAFTY_API_URL, ENV_CRAFTY_USERNAME, crafty_password, crafty_token, ENV_CRAFTY_SERVER_ID, ENV_CRAFTY_PANEL_URL, 1 if ENV_CRAFTY_VERIFY_TLS else 0,
                    1 if bool(ENV_SQUAREMAP_URL) else 0, ENV_SQUAREMAP_URL, ENV_SQUAREMAP_WORLD_ID,
                    timestamp, timestamp,
                ),
            )
            if ENV_CRAFTY_API_URL and (
                ENV_CRAFTY_API_TOKEN or (ENV_CRAFTY_USERNAME and ENV_CRAFTY_PASSWORD)
            ):
                connection_cursor = db.execute(
                    "INSERT INTO crafty_connections("
                    "name, active, api_url, username, password, api_token, "
                    "panel_url, verify_tls, created_at, updated_at"
                    ") VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        "Crafty principal", 1, ENV_CRAFTY_API_URL,
                        ENV_CRAFTY_USERNAME, crafty_password, crafty_token,
                        ENV_CRAFTY_PANEL_URL, 1 if ENV_CRAFTY_VERIFY_TLS else 0,
                        timestamp, timestamp,
                    ),
                )
                db.execute(
                    "UPDATE server_profiles SET crafty_connection_id=?, source_type='crafty' WHERE id=?",
                    (int(connection_cursor.lastrowid), int(profile_cursor.lastrowid)),
                )

        # RC29 created an empty placeholder profile even for "configure later".
        # Hide that untouched placeholder during migration so existing panel-only
        # installs get the same empty first-run experience without deleting data.
        if PANEL_SETUP_MODE == "later":
            active_rows = db.execute(
                "SELECT * FROM server_profiles WHERE active=1 ORDER BY id"
            ).fetchall()
            if len(active_rows) == 1:
                placeholder = row_dict(active_rows[0])
                is_empty_placeholder = (
                    str(placeholder.get("name") or "") == "Primary server"
                    and str(placeholder.get("slug") or "") == "principal"
                    and not bool(placeholder.get("plugin_enabled"))
                    and not str(placeholder.get("plugin_api_url") or "").strip()
                    and not str(placeholder.get("plugin_token") or "").strip()
                    and not bool(placeholder.get("crafty_enabled"))
                    and not int(placeholder.get("crafty_connection_id") or 0)
                    and not str(placeholder.get("crafty_server_id") or "").strip()
                    and not bool(placeholder.get("bluemap_enabled"))
                    and not str(placeholder.get("bluemap_url") or "").strip()
                    and not bool(placeholder.get("squaremap_enabled"))
                    and not str(placeholder.get("squaremap_url") or "").strip()
                )
                if is_empty_placeholder:
                    db.execute(
                        "UPDATE server_profiles SET active=0, is_default=0, updated_at=? WHERE id=?",
                        (now_ts(), int(placeholder["id"])),
                    )

        if not db.execute("SELECT 1 FROM settings WHERE key='onboarding.preferred_mode'").fetchone():
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)",
                ("onboarding.preferred_mode", PANEL_SETUP_MODE, now_ts()),
            )
        # Scope historical data to to server while keeping every existing row on the migrated default profile.
        for table in ("places", "audit", "alerts", "sessions", "metrics"):
            columns = {str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
            if "server_id" not in columns:
                db.execute(f"ALTER TABLE {table} ADD COLUMN server_id INTEGER NOT NULL DEFAULT 1")
        db.execute("CREATE INDEX IF NOT EXISTS audit_server_ts_idx ON audit(server_id, ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS alerts_server_ts_idx ON alerts(server_id, ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS sessions_server_player_idx ON sessions(server_id, player_uuid, joined_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS metrics_server_ts_idx ON metrics(server_id, ts DESC)")
        # Older releases made place names globally unique. Rebuild the table so
        # each server can use familiar names such as Spawn or Tienda independently.
        places_sql_row = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='places'").fetchone()
        places_sql = str(places_sql_row["sql"] or "") if places_sql_row else ""
        if "UNIQUE(server_id, name)" not in places_sql.replace("\n", " "):
            db.execute("""
                CREATE TABLE places_scoped (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    server_id INTEGER NOT NULL DEFAULT 1,
                    name TEXT NOT NULL COLLATE NOCASE,
                    world TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
                    yaw REAL NOT NULL DEFAULT 0, pitch REAL NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    UNIQUE(server_id, name)
                )
            """)
            db.execute("INSERT INTO places_scoped(id, server_id, name, world, x, y, z, yaw, pitch, created_at, updated_at) SELECT id, server_id, name, world, x, y, z, yaw, pitch, created_at, updated_at FROM places")
            db.execute("DROP TABLE places")
            db.execute("ALTER TABLE places_scoped RENAME TO places")
        db.execute("CREATE INDEX IF NOT EXISTS places_server_name_idx ON places(server_id, name COLLATE NOCASE)")

        count = int(db.execute("SELECT COUNT(*) FROM users").fetchone()[0])
        if count == 0:
            timestamp = now_ts()
            salt, digest = password_digest(ADMIN_PASSWORD)
            db.execute(
                "INSERT INTO users(username, display_name, password_hash, password_salt, role, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                ("admin", "Administrator", digest, salt, "admin", 1, timestamp, timestamp),
            )
            logger.warning("Created initial panel user 'admin' using the existing panel password")
        db.execute("DELETE FROM web_sessions WHERE expires_at < ?", (now_ts(),))
        defaults = {
            "metrics.high_cpu_enabled": "1",
            "metrics.high_cpu_threshold": "85",
            "metrics.high_cpu_duration_seconds": "120",
            "metrics.high_memory_enabled": "1",
            "metrics.high_memory_threshold": "90",
            "metrics.high_memory_duration_seconds": "120",
            "metrics.low_tps_enabled": "1",
            "metrics.low_tps_threshold": "17",
            "metrics.low_tps_duration_seconds": "60",
            "metrics.high_storage_enabled": "1",
            "metrics.high_storage_threshold": "90",
            "metrics.high_storage_duration_seconds": "300",
            "metrics.recovery_alerts_enabled": "1",
            "metrics.alert_cooldown_seconds": "900",
            "alerts.server_down_enabled": "1",
            "alerts.server_down_delay_seconds": "30",
            "metrics.retention_days": str(METRICS_RETENTION_DAYS),
            "system.backup_retention": "10",
            "system.audit_retention_days": "180",
            "system.alert_retention_days": "90",
            "system.timezone": DEFAULT_TIMEZONE,
        }
        for key, value in defaults.items():
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING",
                (key, value, now_ts()),
            )
        # Enable the new security notification once for devices that already existed
        # before 1.1.1. Afterwards the user's preference is respected on restarts.
        migration_key = "migration.push.whitelist_denied.1"
        migration_done = db.execute("SELECT 1 FROM settings WHERE key=?", (migration_key,)).fetchone()
        if not migration_done:
            for row in db.execute("SELECT id, event_types_json FROM push_subscriptions").fetchall():
                try:
                    events = set(json.loads(row["event_types_json"] or "[]"))
                except (json.JSONDecodeError, TypeError):
                    events = set(PUSH_DEFAULT_EVENTS)
                events.add("whitelist_denied")
                db.execute(
                    "UPDATE push_subscriptions SET event_types_json=?, updated_at=? WHERE id=?",
                    (json.dumps(sorted(events)), now_ts(), int(row["id"])),
                )
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)",
                (migration_key, "done", now_ts()),
            )

        # 1.1.1 removes low-health alerts from the product entirely.
        health_migration_key = "migration.remove.low_health.1"
        health_migration_done = db.execute("SELECT 1 FROM settings WHERE key=?", (health_migration_key,)).fetchone()
        if not health_migration_done:
            db.execute("DELETE FROM alerts WHERE type='low_health'")
            for row in db.execute("SELECT id, event_types_json FROM push_subscriptions").fetchall():
                try:
                    events = set(json.loads(row["event_types_json"] or "[]"))
                except (json.JSONDecodeError, TypeError):
                    events = set(PUSH_DEFAULT_EVENTS)
                events.discard("low_health")
                db.execute(
                    "UPDATE push_subscriptions SET event_types_json=?, updated_at=? WHERE id=?",
                    (json.dumps(sorted(events)), now_ts(), int(row["id"])),
                )
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)",
                (health_migration_key, "done", now_ts()),
            )


def setting_value(key: str, default: str = "") -> str:
    with db_connect() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return str(row["value"]) if row else default


def setting_float(key: str, default: float) -> float:
    try:
        return float(setting_value(key, str(default)))
    except (TypeError, ValueError):
        return default


def setting_bool(key: str, default: bool = False) -> bool:
    value = setting_value(key, "1" if default else "0").strip().lower()
    return value in {"1", "true", "yes", "on"}


def encrypted_setting_value(key: str, default: str = "") -> str:
    value = setting_value(key, "")
    if not value:
        return default
    if not value.startswith("fernet:"):
        return default
    try:
        return CONNECTION_CIPHER.decrypt(value[7:].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeDecodeError):
        logger.warning("Unable to decrypt connection setting %s; using environment fallback", key)
        return default


def save_setting(key: str, value: str) -> None:
    with db_connect() as db:
        db.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, now_ts()),
        )


def save_encrypted_setting(key: str, value: str) -> None:
    encrypted = CONNECTION_CIPHER.encrypt(value.encode("utf-8")).decode("ascii")
    save_setting(key, "fernet:" + encrypted)


REQUEST_CONTEXT = threading.local()


def _decrypt_profile_secret(value: str) -> str:
    text = str(value or "")
    if not text:
        return ""
    if not text.startswith("fernet:"):
        return ""
    try:
        return CONNECTION_CIPHER.decrypt(text[7:].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeDecodeError):
        return ""



def _encrypt_profile_secret(value: str) -> str:
    text = str(value or "")
    return (
        "fernet:" + CONNECTION_CIPHER.encrypt(text.encode("utf-8")).decode("ascii")
        if text else ""
    )


def crafty_connection_config(connection_id: Any, *, active_only: bool = True) -> dict[str, Any]:
    try:
        resolved = int(connection_id or 0)
    except (TypeError, ValueError):
        resolved = 0
    if resolved <= 0:
        raise ValueError("Select to Crafty installation")
    query = "SELECT * FROM crafty_connections WHERE id=?"
    if active_only:
        query += " AND active=1"
    with db_connect() as db:
        row = db.execute(query, (resolved,)).fetchone()
    if not row:
        raise ValueError("The Crafty installation does not exist or is disabled")
    data = row_dict(row)
    return {
        "id": int(data["id"]),
        "name": str(data.get("name") or f"Crafty {data['id']}"),
        "active": bool(data.get("active", 1)),
        "apiUrl": str(data.get("api_url") or "").rstrip("/"),
        "username": str(data.get("username") or ""),
        "password": _decrypt_profile_secret(str(data.get("password") or "")),
        "apiToken": _decrypt_profile_secret(str(data.get("api_token") or "")),
        "accessClientId": str(data.get("access_client_id") or ""),
        "accessClientSecret": _decrypt_profile_secret(str(data.get("access_client_secret") or "")),
        "panelUrl": str(data.get("panel_url") or "").rstrip("/"),
        "verifyTls": bool(data.get("verify_tls", 0)),
        "createdAt": int(data.get("created_at") or 0),
        "updatedAt": int(data.get("updated_at") or 0),
    }


def public_crafty_connection(connection_id: Any) -> dict[str, Any]:
    config = crafty_connection_config(connection_id, active_only=False)
    configured = bool(
        config["active"] and config["apiUrl"]
        and (config["apiToken"] or (config["username"] and config["password"]))
    )
    with db_connect() as db:
        linked = int(db.execute(
            "SELECT COUNT(*) FROM server_profiles "
            "WHERE active=1 AND crafty_connection_id=?",
            (config["id"],),
        ).fetchone()[0])
    return {
        "id": config["id"],
        "name": config["name"],
        "active": config["active"],
        "configured": configured,
        "apiUrl": config["apiUrl"],
        "panelUrl": config["panelUrl"],
        "username": config["username"],
        "passwordConfigured": bool(config["password"]),
        "apiTokenConfigured": bool(config["apiToken"]),
        "accessClientId": config["accessClientId"],
        "accessClientSecretConfigured": bool(config["accessClientSecret"]),
        "verifyTls": config["verifyTls"],
        "linkedServers": linked,
        "target": connection_url_metadata(config["apiUrl"]),
        "createdAt": config["createdAt"],
        "updatedAt": config["updatedAt"],
    }


def list_crafty_connections_public() -> list[dict[str, Any]]:
    with db_connect() as db:
        ids = [
            int(row["id"])
            for row in db.execute(
                "SELECT id FROM crafty_connections "
                "WHERE active=1 ORDER BY name COLLATE NOCASE, id"
            ).fetchall()
        ]
    return [public_crafty_connection(connection_id) for connection_id in ids]


def _unique_crafty_connection_name(name: str, exclude_id: int = 0) -> str:
    base = str(name or "").strip()[:80] or "Crafty"
    candidate = base
    suffix = 2
    with db_connect() as db:
        while db.execute(
            "SELECT 1 FROM crafty_connections "
            "WHERE name=? COLLATE NOCASE AND id<>?",
            (candidate, int(exclude_id or 0)),
        ).fetchone():
            candidate = f"{base} {suffix}"
            suffix += 1
    return candidate


def save_crafty_connection(data: dict[str, Any]) -> dict[str, Any]:
    connection_id = int(data.get("id") or 0)
    existing = (
        crafty_connection_config(connection_id, active_only=False)
        if connection_id else None
    )
    name = str(data.get("name", existing["name"] if existing else "")).strip()
    if not name or len(name) > 80:
        raise ValueError("Enter to Crafty installation name of up to 80 characters")
    api_url = validate_connection_url(
        data.get("apiUrl", existing["apiUrl"] if existing else ENV_CRAFTY_API_URL),
        "Crafty address",
        direct_scheme="https",
        direct_port=8443,
    )
    panel_raw = str(
        data.get("panelUrl", existing["panelUrl"] if existing else "")
    ).strip()
    panel_url = (
        validate_connection_url(panel_raw, "Public Crafty address", direct_scheme="https", direct_port=8443)
        if panel_raw else ""
    )
    username = str(
        data.get("username", existing["username"] if existing else "")
    ).strip()
    supplied_password = str(data.get("password") or "")
    supplied_token = str(data.get("apiToken") or "").strip()
    supplied_access_secret = str(data.get("accessClientSecret") or "")
    password = supplied_password or (existing["password"] if existing else "")
    api_token = supplied_token or (existing["apiToken"] if existing else "")
    access_client_id = str(data.get("accessClientId", existing["accessClientId"] if existing else "")).strip()
    access_client_secret = supplied_access_secret or (existing["accessClientSecret"] if existing else "")
    if bool(access_client_id) != bool(access_client_secret):
        raise ValueError("Configure both Cloudflare Access service-token values")
    verify_tls = bool(
        data.get("verifyTls", existing["verifyTls"] if existing else False)
    )
    if not api_token and not (username and password):
        raise ValueError("Configure to Crafty API token or username and password")

    encrypted_password = _encrypt_profile_secret(password)
    encrypted_token = _encrypt_profile_secret(api_token)
    encrypted_access_secret = _encrypt_profile_secret(access_client_secret)
    timestamp = now_ts()
    stored_name = _unique_crafty_connection_name(name, connection_id)
    with db_connect() as db:
        if connection_id:
            cursor = db.execute(
                "UPDATE crafty_connections SET name=?, active=1, api_url=?, "
                "username=?, password=?, api_token=?, access_client_id=?, "
                "access_client_secret=?, panel_url=?, verify_tls=?, "
                "updated_at=? WHERE id=?",
                (
                    stored_name, api_url, username, encrypted_password,
                    encrypted_token, access_client_id, encrypted_access_secret,
                    panel_url, 1 if verify_tls else 0, timestamp, connection_id,
                ),
            )
            if cursor.rowcount == 0:
                raise ValueError("Crafty installation not found")
        else:
            cursor = db.execute(
                "INSERT INTO crafty_connections("
                "name, active, api_url, username, password, api_token, "
                "access_client_id, access_client_secret, panel_url, verify_tls, "
                "created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    stored_name, 1, api_url, username, encrypted_password,
                    encrypted_token, access_client_id, encrypted_access_secret,
                    panel_url, 1 if verify_tls else 0, timestamp, timestamp,
                ),
            )
            connection_id = int(cursor.lastrowid)

        db.execute(
            "UPDATE server_profiles SET crafty_api_url=?, crafty_username=?, "
            "crafty_password=?, crafty_api_token=?, crafty_panel_url=?, "
            "crafty_verify_tls=?, updated_at=? WHERE crafty_connection_id=?",
            (
                api_url, username, encrypted_password, encrypted_token,
                panel_url, 1 if verify_tls else 0, timestamp, connection_id,
            ),
        )

    reset_crafty_connection_runtime(connection_id)
    with db_connect() as db:
        linked_ids = [
            int(row["id"])
            for row in db.execute(
                "SELECT id FROM server_profiles WHERE crafty_connection_id=?",
                (connection_id,),
            ).fetchall()
        ]
    for profile_id in linked_ids:
        reset_server_runtime(profile_id)
    return public_crafty_connection(connection_id)


def delete_crafty_connection(connection_id: int) -> None:
    config = crafty_connection_config(connection_id, active_only=False)
    with db_connect() as db:
        linked = int(db.execute(
            "SELECT COUNT(*) FROM server_profiles "
            "WHERE active=1 AND crafty_connection_id=?",
            (config["id"],),
        ).fetchone()[0])
        if linked:
            raise ValueError(
                f"Cannot delete: {linked} server(s) use this installation"
            )
        db.execute(
            "UPDATE crafty_connections SET active=0, updated_at=? WHERE id=?",
            (now_ts(), config["id"]),
        )
    reset_crafty_connection_runtime(config["id"])



def default_server_id() -> int:
    with db_connect() as db:
        row = db.execute(
            "SELECT id FROM server_profiles WHERE active=1 ORDER BY is_default DESC, id ASC LIMIT 1"
        ).fetchone()
    return int(row["id"]) if row else 0


def resolve_server_id(value: Any = None, *, active_only: bool = True) -> int:
    try:
        requested = int(value or 0)
    except (TypeError, ValueError):
        requested = 0
    with db_connect() as db:
        if requested > 0:
            query = "SELECT id FROM server_profiles WHERE id=?" + (" AND active=1" if active_only else "")
            row = db.execute(query, (requested,)).fetchone()
            if row:
                return int(row["id"])
        row = db.execute(
            "SELECT id FROM server_profiles " + ("WHERE active=1 " if active_only else "") +
            "ORDER BY is_default DESC, id ASC LIMIT 1"
        ).fetchone()
    return int(row["id"]) if row else 0


def set_current_server_id(value: Any) -> int:
    server_id = resolve_server_id(value)
    REQUEST_CONTEXT.server_id = server_id
    return server_id


def current_server_id() -> int:
    return resolve_server_id(getattr(REQUEST_CONTEXT, "server_id", 0))


def server_profile_config(server_id: Any = None) -> dict[str, Any]:
    resolved = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    with db_connect() as db:
        row = db.execute("SELECT * FROM server_profiles WHERE id=?", (resolved,)).fetchone()
    if not row:
        raise RuntimeError("No server is configured")
    data = row_dict(row)
    crafty_connection_id = int(data.get("crafty_connection_id") or 0)
    shared_crafty = None
    if crafty_connection_id:
        try:
            shared_crafty = crafty_connection_config(crafty_connection_id)
        except ValueError:
            shared_crafty = None
    return {
        "id": int(data["id"]),
        "name": str(data.get("name") or f"Server {data['id']}"),
        "slug": str(data.get("slug") or data["id"]),
        "active": bool(data.get("active", 1)),
        "isDefault": bool(data.get("is_default", 0)),
        "sourceType": (
            str(data.get("source_type") or "").strip().lower()
            if str(data.get("source_type") or "").strip().lower() in {"crafty", "manual"}
            else ("crafty" if crafty_connection_id or bool(data.get("crafty_enabled", 0)) else "manual")
        ),
        "plugin": {
            "enabled": bool(data.get("plugin_enabled", 0)),
            "apiUrl": str(data.get("plugin_api_url") or "").rstrip("/"),
            "apiToken": _decrypt_profile_secret(str(data.get("plugin_token") or "")),
            "accessClientId": str(data.get("plugin_access_client_id") or ""),
            "accessClientSecret": _decrypt_profile_secret(str(data.get("plugin_access_client_secret") or "")),
            "verifyTls": bool(data.get("plugin_verify_tls", 1)),
        },
        "crafty": {
            "enabled": bool(data.get("crafty_enabled", 0)),
            "connectionId": crafty_connection_id if shared_crafty else 0,
            "connectionName": shared_crafty["name"] if shared_crafty else "",
            "apiUrl": shared_crafty["apiUrl"] if shared_crafty else str(data.get("crafty_api_url") or "").rstrip("/"),
            "username": shared_crafty["username"] if shared_crafty else str(data.get("crafty_username") or ""),
            "password": shared_crafty["password"] if shared_crafty else _decrypt_profile_secret(str(data.get("crafty_password") or "")),
            "apiToken": shared_crafty["apiToken"] if shared_crafty else _decrypt_profile_secret(str(data.get("crafty_api_token") or "")),
            "accessClientId": shared_crafty["accessClientId"] if shared_crafty else "",
            "accessClientSecret": shared_crafty["accessClientSecret"] if shared_crafty else "",
            "serverId": str(data.get("crafty_server_id") or ""),
            "panelUrl": shared_crafty["panelUrl"] if shared_crafty else str(data.get("crafty_panel_url") or ""),
            "verifyTls": shared_crafty["verifyTls"] if shared_crafty else bool(data.get("crafty_verify_tls", 0)),
        },
        "blueMap": {
            "enabled": bool(data.get("bluemap_enabled", 0)),
            "url": str(data.get("bluemap_url") or "").rstrip("/"),
            "mapId": str(data.get("bluemap_map_id") or ""),
        },
        "squareMap": {
            "enabled": bool(data.get("squaremap_enabled", 0)),
            "url": str(data.get("squaremap_url") or "").rstrip("/"),
            "worldId": str(data.get("squaremap_world_id") or "minecraft:overworld"),
        },
    }


def public_server_profile(server_id: Any = None) -> dict[str, Any]:
    config = server_profile_config(server_id)
    plugin = config["plugin"]
    crafty = config["crafty"]
    bluemap = config["blueMap"]
    squaremap = config["squareMap"]
    plugin_configured = bool(plugin["enabled"] and plugin["apiUrl"] and plugin["apiToken"])
    crafty_configured = bool(
        crafty["enabled"] and crafty["apiUrl"] and crafty["serverId"]
        and (crafty["apiToken"] or (crafty["username"] and crafty["password"]))
    )
    return {
        "id": config["id"],
        "name": config["name"],
        "slug": config["slug"],
        "active": config["active"],
        "isDefault": config["isDefault"],
        "sourceType": config["sourceType"],
        "plugin": {
            "enabled": plugin["enabled"],
            "configured": plugin_configured,
            "apiUrl": plugin["apiUrl"],
            "tokenConfigured": bool(plugin["apiToken"]),
            "accessClientId": plugin.get("accessClientId", ""),
            "accessClientSecretConfigured": bool(plugin.get("accessClientSecret")),
            "verifyTls": plugin["verifyTls"],
            "target": connection_url_metadata(plugin["apiUrl"]),
        },
        "crafty": {
            "enabled": crafty["enabled"],
            "configured": crafty_configured,
            "connectionId": int(crafty.get("connectionId") or 0),
            "connectionName": str(crafty.get("connectionName") or ""),
            "apiUrl": crafty["apiUrl"],
            "serverId": crafty["serverId"],
            "panelUrl": crafty["panelUrl"],
            "verifyTls": crafty["verifyTls"],
            "username": crafty["username"],
            "passwordConfigured": bool(crafty["password"]),
            "apiTokenConfigured": bool(crafty["apiToken"]),
            "accessClientId": crafty.get("accessClientId", ""),
            "accessClientSecretConfigured": bool(crafty.get("accessClientSecret")),
            "target": connection_url_metadata(crafty["apiUrl"]),
        },
        "blueMap": {
            "enabled": bluemap["enabled"],
            "configured": bool(bluemap["enabled"] and bluemap["url"]),
            "url": bluemap["url"],
            "mapId": bluemap["mapId"],
        },
        "squareMap": {
            "enabled": squaremap["enabled"],
            "configured": bool(squaremap["enabled"] and squaremap["url"]),
            "url": squaremap["url"],
            "worldId": squaremap["worldId"],
        },
    }


def list_server_profiles_public() -> list[dict[str, Any]]:
    with db_connect() as db:
        ids = [int(row["id"]) for row in db.execute(
            "SELECT id FROM server_profiles WHERE active=1 ORDER BY is_default DESC, name COLLATE NOCASE, id"
        ).fetchall()]
    return [public_server_profile(server_id) for server_id in ids]


def _unique_server_slug(name: str, exclude_id: int = 0) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "server"
    slug = base
    suffix = 2
    with db_connect() as db:
        while db.execute("SELECT 1 FROM server_profiles WHERE slug=? AND id<>?", (slug, exclude_id)).fetchone():
            slug = f"{base}-{suffix}"
            suffix += 1
    return slug


def save_server_profile(data: dict[str, Any]) -> dict[str, Any]:
    profile_id = int(data.get("id") or 0)
    name = str(data.get("name") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("Enter to server name of up to 80 characters")
    timestamp = now_ts()
    existing = server_profile_config(profile_id) if profile_id else None
    source_type = str(
        data.get("sourceType", existing["sourceType"] if existing else "manual")
    ).strip().lower()
    if source_type not in {"crafty", "manual"}:
        raise ValueError("The server source must be Crafty or manual")
    plugin_data = data.get("plugin") if isinstance(data.get("plugin"), dict) else {}
    crafty_data = data.get("crafty") if isinstance(data.get("crafty"), dict) else {}
    bluemap_data = data.get("blueMap") if isinstance(data.get("blueMap"), dict) else {}
    squaremap_data = data.get("squareMap") if isinstance(data.get("squareMap"), dict) else {}

    plugin_url = validate_connection_url(plugin_data.get("apiUrl", existing["plugin"]["apiUrl"] if existing else ENV_API_URL), "Plugin address", direct_scheme="http", direct_port=8765)
    plugin_enabled = bool(plugin_data.get("enabled", True))
    supplied_plugin_token = str(plugin_data.get("apiToken") or "").strip()
    supplied_plugin_access_secret = str(plugin_data.get("accessClientSecret") or "")
    plugin_verify_tls = bool(plugin_data.get("verifyTls", existing["plugin"]["verifyTls"] if existing else True))
    plugin_token = supplied_plugin_token or (existing["plugin"]["apiToken"] if existing else "")
    plugin_access_client_id = str(plugin_data.get("accessClientId", existing["plugin"].get("accessClientId", "") if existing else "")).strip()
    plugin_access_client_secret = supplied_plugin_access_secret or (existing["plugin"].get("accessClientSecret", "") if existing else "")
    if bool(plugin_access_client_id) != bool(plugin_access_client_secret):
        raise ValueError("Configure both Cloudflare Access service-token values for the plugin")
    if plugin_enabled and not plugin_token:
        raise ValueError("Enter the plugin API token")
    if supplied_plugin_token and len(supplied_plugin_token) < 32:
        raise ValueError("The plugin token must contain at least 32 characters")

    crafty_enabled = bool(crafty_data.get("enabled", False))
    crafty_connection_id = int(
        crafty_data.get(
            "connectionId",
            existing["crafty"].get("connectionId", 0) if existing else 0,
        ) or 0
    )
    shared_crafty = crafty_connection_config(crafty_connection_id) if crafty_connection_id else None
    crafty_server_id = str(
        crafty_data.get("serverId", existing["crafty"]["serverId"] if existing else "")
    ).strip()
    if shared_crafty:
        crafty_url = shared_crafty["apiUrl"]
        crafty_panel_url = shared_crafty["panelUrl"]
        crafty_username = shared_crafty["username"]
        crafty_password = shared_crafty["password"]
        crafty_token = shared_crafty["apiToken"]
        crafty_verify_tls = shared_crafty["verifyTls"]
    else:
        crafty_url = validate_connection_url(
            crafty_data.get("apiUrl", existing["crafty"]["apiUrl"] if existing else ENV_CRAFTY_API_URL),
            "Crafty address",
            direct_scheme="https",
            direct_port=8443,
        )
        crafty_panel_raw = str(crafty_data.get("panelUrl", existing["crafty"]["panelUrl"] if existing else "")).strip()
        crafty_panel_url = validate_connection_url(
            crafty_panel_raw,
            "Public Crafty address",
            direct_scheme="https",
            direct_port=8443,
        ) if crafty_panel_raw else ""
        crafty_username = str(crafty_data.get("username", existing["crafty"]["username"] if existing else "")).strip()
        supplied_password = str(crafty_data.get("password") or "")
        supplied_crafty_token = str(crafty_data.get("apiToken") or "").strip()
        crafty_password = supplied_password or (existing["crafty"]["password"] if existing else "")
        crafty_token = supplied_crafty_token or (existing["crafty"]["apiToken"] if existing else "")
        crafty_verify_tls = bool(crafty_data.get("verifyTls", existing["crafty"]["verifyTls"] if existing else False))
    if source_type == "crafty":
        crafty_enabled = True
    if source_type == "manual" and not crafty_enabled:
        crafty_connection_id = 0
        crafty_server_id = ""
    if crafty_enabled and not crafty_server_id:
        raise ValueError("Enter the Crafty server ID")
    if crafty_enabled and not crafty_connection_id and not crafty_token and not (crafty_username and crafty_password):
        raise ValueError("Select to Crafty installation or configure credentials")

    bluemap_enabled = bool(bluemap_data.get("enabled", False))
    bluemap_raw = str(bluemap_data.get("url", existing["blueMap"]["url"] if existing else "")).strip()
    bluemap_url = validate_connection_url(bluemap_raw, "BlueMap address", direct_scheme="http") if bluemap_raw else ""
    if bluemap_enabled and not bluemap_url:
        raise ValueError("Enter the public BlueMap URL")
    bluemap_map_id = str(bluemap_data.get("mapId", existing["blueMap"]["mapId"] if existing else "")).strip()[:128]
    squaremap_enabled = bool(squaremap_data.get("enabled", existing["squareMap"]["enabled"] if existing else False))
    squaremap_raw = str(squaremap_data.get("url", existing["squareMap"]["url"] if existing else "")).strip()
    squaremap_url = validate_connection_url(squaremap_raw, "squaremap address", direct_scheme="http") if squaremap_raw else ""
    if squaremap_enabled and not squaremap_url:
        raise ValueError("Enter the public squaremap URL")
    squaremap_world_id = str(squaremap_data.get("worldId", existing["squareMap"]["worldId"] if existing else "minecraft:overworld")).strip()[:128] or "minecraft:overworld"
    make_default = bool(data.get("isDefault", existing["isDefault"] if existing else False))
    slug = _unique_server_slug(name, profile_id)

    encrypted_plugin = "fernet:" + CONNECTION_CIPHER.encrypt(plugin_token.encode("utf-8")).decode("ascii") if plugin_token else ""
    encrypted_plugin_access_secret = _encrypt_profile_secret(plugin_access_client_secret)
    encrypted_password = _encrypt_profile_secret(crafty_password)
    encrypted_crafty_token = _encrypt_profile_secret(crafty_token)
    with db_connect() as db:
        if make_default:
            db.execute("UPDATE server_profiles SET is_default=0")
        if profile_id:
            cursor = db.execute(
                "UPDATE server_profiles SET name=?, slug=?, active=1, is_default=?, source_type=?, plugin_enabled=?, plugin_api_url=?, plugin_token=?, plugin_verify_tls=?, plugin_access_client_id=?, plugin_access_client_secret=?, crafty_enabled=?, crafty_connection_id=?, crafty_api_url=?, crafty_username=?, crafty_password=?, crafty_api_token=?, crafty_server_id=?, crafty_panel_url=?, crafty_verify_tls=?, bluemap_enabled=?, bluemap_url=?, bluemap_map_id=?, squaremap_enabled=?, squaremap_url=?, squaremap_world_id=?, updated_at=? WHERE id=?",
                (name, slug, 1 if make_default else 0, source_type, 1 if plugin_enabled else 0, plugin_url, encrypted_plugin, 1 if plugin_verify_tls else 0, plugin_access_client_id, encrypted_plugin_access_secret, 1 if crafty_enabled else 0, crafty_connection_id,
                 crafty_url, crafty_username, encrypted_password, encrypted_crafty_token, crafty_server_id, crafty_panel_url,
                 1 if crafty_verify_tls else 0,
                 1 if bluemap_enabled else 0, bluemap_url, bluemap_map_id,
                 1 if squaremap_enabled else 0, squaremap_url, squaremap_world_id, timestamp, profile_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("Server not found")
        else:
            cursor = db.execute(
                "INSERT INTO server_profiles(name, slug, active, is_default, source_type, plugin_enabled, plugin_api_url, plugin_token, plugin_verify_tls, plugin_access_client_id, plugin_access_client_secret, crafty_enabled, crafty_connection_id, crafty_api_url, crafty_username, crafty_password, crafty_api_token, crafty_server_id, crafty_panel_url, crafty_verify_tls, bluemap_enabled, bluemap_url, bluemap_map_id, squaremap_enabled, squaremap_url, squaremap_world_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (name, slug, 1, 1 if make_default else 0, source_type, 1 if plugin_enabled else 0, plugin_url, encrypted_plugin, 1 if plugin_verify_tls else 0, plugin_access_client_id, encrypted_plugin_access_secret, 1 if crafty_enabled else 0, crafty_connection_id,
                 crafty_url, crafty_username, encrypted_password, encrypted_crafty_token, crafty_server_id, crafty_panel_url,
                 1 if crafty_verify_tls else 0, 1 if bluemap_enabled else 0, bluemap_url, bluemap_map_id,
                 1 if squaremap_enabled else 0, squaremap_url, squaremap_world_id, timestamp, timestamp),
            )
            profile_id = int(cursor.lastrowid)
        if not db.execute("SELECT 1 FROM server_profiles WHERE is_default=1 AND active=1").fetchone():
            db.execute("UPDATE server_profiles SET is_default=1 WHERE id=?", (profile_id,))
    reset_server_runtime(profile_id)
    return public_server_profile(profile_id)


def delete_server_profile(profile_id: int) -> None:
    profile_id = resolve_server_id(profile_id, active_only=False)
    with db_connect() as db:
        active_count = int(db.execute("SELECT COUNT(*) FROM server_profiles WHERE active=1").fetchone()[0])
        row = db.execute("SELECT is_default FROM server_profiles WHERE id=?", (profile_id,)).fetchone()
        if not row:
            raise ValueError("Server not found")
        if active_count <= 1:
            raise ValueError("At least one active server must exist")
        db.execute("UPDATE server_profiles SET active=0, is_default=0, updated_at=? WHERE id=?", (now_ts(), profile_id))
        if bool(row["is_default"]):
            replacement = db.execute("SELECT id FROM server_profiles WHERE active=1 ORDER BY id LIMIT 1").fetchone()
            if replacement:
                db.execute("UPDATE server_profiles SET is_default=1 WHERE id=?", (int(replacement["id"]),))
    stop_server_monitor(profile_id)


def validate_connection_url(
    value: Any,
    label: str,
    *,
    direct_scheme: str = "https",
    direct_port: int = 0,
    domain_scheme: str = "https",
) -> str:
    """Validate and normalize to service address.

    Besides complete HTTP(S) URLs, the web UI accepts direct IPv4/IPv6
    addresses and host names. Private/local targets use the service's native
    scheme and port, while public domain names default to HTTPS without an
    internal port.
    """
    text = str(value or "").strip().rstrip("/")
    if not text:
        raise ValueError(f"{label} is empty")
    original_had_scheme = bool(re.match(r"^https?://", text, re.IGNORECASE))
    if "://" in text and not original_had_scheme:
        raise ValueError(f"{label} must use http:// or https://")

    if not original_had_scheme:
        raw = text
        # Accept to plain IPv6 literal by adding the URL brackets automatically.
        if not raw.startswith("[") and raw.count(":") > 1 and "/" not in raw:
            try:
                ipaddress.ip_address(raw)
                raw = f"[{raw}]"
            except ValueError:
                pass
        authority = raw.split("/", 1)[0]
        if authority.startswith("[") and "]" in authority:
            host_hint = authority[1:authority.index("]")]
        elif authority.count(":") == 1:
            host_hint = authority.rsplit(":", 1)[0]
        else:
            host_hint = authority
        host_lower = host_hint.strip().lower()
        try:
            ipaddress.ip_address(host_lower)
            direct_target = True
        except ValueError:
            direct_target = (
                "." not in host_lower
                or host_lower.endswith((".local", ".internal", ".lan"))
            )
        scheme = direct_scheme if direct_target else domain_scheme
        text = f"{scheme}://{raw}"
    else:
        direct_target = False

    parsed = urlparse(text)
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise ValueError(f"{label} contains an invalid port") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(
            f"{label} must be to valid IP address, hostname, or HTTP/HTTPS URL"
        )
    if parsed_port is not None and not 1 <= parsed_port <= 65535:
        raise ValueError(f"{label} contains a port outside the valid range")
    if parsed.query or parsed.fragment:
        raise ValueError(f"{label} must not contain query parameters or fragments")

    if not original_had_scheme and direct_target and direct_port and parsed_port is None:
        hostname = str(parsed.hostname or "")
        host_for_netloc = f"[{hostname}]" if ":" in hostname else hostname
        parsed = parsed._replace(netloc=f"{host_for_netloc}:{int(direct_port)}")

    return parsed.geturl().rstrip("/")


def connection_url_metadata(value: Any) -> dict[str, Any]:
    """Return to safe description of where to backend connection is routed."""
    text = str(value or "").strip().rstrip("/")
    parsed = urlparse(text)
    hostname = str(parsed.hostname or "").strip()
    lower = hostname.lower()
    try:
        parsed_port = parsed.port
    except ValueError:
        parsed_port = None
    port = parsed_port or (443 if parsed.scheme == "https" else 80 if parsed.scheme == "http" else 0)
    if lower in {"localhost", "127.0.0.1", "::1"}:
        route = "container-loopback"
        label = "Web container"
        warning = "localhost and 127.0.0.1 point to the panel container itself, not the Docker host."
    elif lower in {DOCKER_HOST_GATEWAY_NAME.lower(), "host.docker.internal", "gateway.docker.internal"}:
        route = "docker-host"
        label = "Docker host port"
        warning = ""
    else:
        try:
            ipaddress.ip_address(lower)
            direct_ip = True
        except ValueError:
            direct_ip = False
        if direct_ip:
            route = "direct-ip"
            label = "Direct IP"
            warning = "Use HTTPS or to private IP/VPN when the connection crosses the Internet." if parsed.scheme == "http" else ""
        elif hostname and ("." not in hostname or lower.endswith((".local", ".internal", ".lan"))):
            route = "docker-network"
            label = "Internal Docker/LAN network"
            warning = ""
        else:
            route = "remote"
            label = "Remote server"
            warning = "Use HTTPS or to private network/VPN when the connection crosses an untrusted network." if parsed.scheme == "http" else ""
    return {
        "url": text,
        "scheme": parsed.scheme,
        "host": hostname,
        "port": int(port or 0),
        "route": route,
        "label": label,
        "warning": warning,
        "tls": parsed.scheme == "https",
    }


def _connection_exception_reason(exc: BaseException) -> BaseException:
    reason = getattr(exc, "reason", None)
    return reason if isinstance(reason, BaseException) else exc


def connection_error_diagnostic(value: Any, exc: BaseException) -> dict[str, Any]:
    target = connection_url_metadata(value)
    reason = _connection_exception_reason(exc)
    detail = str(reason or exc).strip() or reason.__class__.__name__
    category = "network"
    hint = "Check the URL, network route, and whether the service is listening."
    error_number = getattr(reason, "errno", None)
    if isinstance(reason, socket.gaierror):
        category = "dns"
        hint = f"Could not resolve {target['host']}. On Docker for Linux, use {DOCKER_HOST_GATEWAY_NAME} to reach the host."
    elif isinstance(reason, ConnectionRefusedError) or error_number in {111, 61, 10061}:
        category = "refused"
        hint = f"The host responded, but no service is listening on port {target['port']}."
    elif isinstance(reason, (TimeoutError, socket.timeout)) or error_number in {110, 60, 10060}:
        category = "timeout"
        hint = "The connection timed out; check the firewall, port publication, and network route."
    elif isinstance(reason, ssl.SSLCertVerificationError):
        category = "tls-certificate"
        hint = "The TLS certificate is not valid for this hostname. Install to trusted certificate or disable verification only on to private network."
    elif isinstance(reason, ssl.SSLError):
        category = "tls"
        hint = "TLS negotiation failed; verify whether the port uses HTTP or HTTPS and inspect the presented certificate."
    if target.get("route") == "container-loopback":
        hint = f"{target['warning']} Use http://{DOCKER_HOST_GATEWAY_NAME}:{target['port']} for a port published on the host."
    return {
        "category": category,
        "detail": detail[:320],
        "hint": hint,
        "target": target,
    }


def access_proxy_headers(config: dict[str, Any]) -> dict[str, str]:
    """Build optional Cloudflare Access service-token headers."""
    client_id = str(config.get("accessClientId") or "").strip()
    client_secret = str(config.get("accessClientSecret") or "").strip()
    if client_id and client_secret:
        return {
            "CF-Access-Client-Id": client_id,
            "CF-Access-Client-Secret": client_secret,
        }
    return {}


def safe_response_headers(headers: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in ("server", "cf-ray", "content-type", "location", "www-authenticate"):
        try:
            value = str(headers.get(name, "") or "").strip()
        except (AttributeError, TypeError):
            value = ""
        if value:
            result[name] = value[:300]
    return result


def attach_http_metadata(payload: Any, headers: Any) -> Any:
    if isinstance(payload, dict):
        result = dict(payload)
        metadata = safe_response_headers(headers)
        if metadata:
            result["_http"] = metadata
        return result
    return payload


def response_payload_text(payload: Any) -> str:
    if isinstance(payload, dict):
        filtered = {key: value for key, value in payload.items() if key != "_http"}
        try:
            return json.dumps(filtered, ensure_ascii=False).lower()
        except (TypeError, ValueError):
            return str(filtered).lower()
    return str(payload or "").lower()


def crafty_auth_failure_message(status: int, payload: Any) -> tuple[str, dict[str, Any]]:
    text = response_payload_text(payload)
    headers = payload.get("_http", {}) if isinstance(payload, dict) else {}
    server_header = str(headers.get("server", "")).lower()
    cloudflare = bool(headers.get("cf-ray")) or "cloudflare" in server_header or "cloudflare access" in text
    diagnostic: dict[str, Any] = {
        "category": "authentication",
        "detail": f"Crafty returned HTTP {int(status)}",
        "hint": "Use to dedicated Crafty API token and verify that the account can access the server.",
    }
    if cloudflare:
        diagnostic.update({
            "category": "cloudflare-access",
            "hint": "Cloudflare blocked the server request. Use to direct IP or private network/VPN, or adjust the domain security rule.",
        })
        return "Cloudflare rejected the Player Panel connection", diagnostic
    if int(status) in {502, 503, 504}:
        diagnostic.update({
            "category": "reverse-proxy",
            "hint": "The proxy could not reach Crafty. Check the target host, port 8443, and the HTTPS scheme of the reverse proxy.",
        })
        return "The reverse proxy could not connect to Crafty", diagnostic
    if int(status) == 403 and any(term in text for term in ("mfa", "totp", "multi factor", "two-factor", "2fa")):
        diagnostic.update({
            "category": "mfa-required",
            "hint": "The account requires MFA. For server-to-server integration, use to dedicated API token instead of username and password.",
        })
        return "Crafty requires MFA for this account", diagnostic
    if int(status) == 403:
        diagnostic["hint"] = "Crafty rejected the login. Verify that the account is active, the password is correct, and MFA is not required; preferably use to dedicated API token."
        return "Crafty rejected the credentials or requires additional authentication", diagnostic
    if int(status) == 401:
        diagnostic["hint"] = "The token or credentials are invalid. Generate to new API token and paste it into Player Panel."
        return "Crafty rejected the token or credentials", diagnostic
    return f"Crafty could not authenticate the connection (HTTP {int(status)})", diagnostic


class CraftyAuthError(RuntimeError):
    def __init__(self, status: int, message: str, diagnostic: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = int(status)
        self.diagnostic = diagnostic or {}


def load_connection_overrides() -> None:
    # Kept as to compatibility hook for older callers. Server profiles are now
    # resolved per request and no global connection switch is required.
    reset_server_runtime()


def connection_settings_public(server_id: Any = None) -> dict[str, Any]:
    resolved = resolve_server_id(server_id)
    if resolved <= 0:
        return {
            "plugin": {"enabled": False, "configured": False, "available": False, "apiUrl": "", "verifyTls": True},
            "crafty": {"enabled": False, "configured": False, "available": False, "connectionId": 0, "serverId": ""},
            "blueMap": {"enabled": False, "configured": False, "url": "", "mapId": ""},
            "squareMap": {"enabled": False, "configured": False, "url": "", "worldId": "minecraft:overworld"},
            "server": {"id": 0, "name": ""},
        }
    profile = public_server_profile(resolved)
    return {"plugin": profile["plugin"], "crafty": profile["crafty"], "blueMap": profile["blueMap"], "squareMap": profile["squareMap"], "server": {"id": profile["id"], "name": profile["name"]}}


def connection_flags_public(server_id: Any = None) -> dict[str, Any]:
    settings = connection_settings_public(server_id)
    return {
        "plugin": {"configured": bool(settings["plugin"]["configured"])},
        "crafty": {"configured": bool(settings["crafty"]["configured"])},
        "blueMap": {"configured": bool(settings["blueMap"]["configured"])},
        "squareMap": {"configured": bool(settings["squareMap"]["configured"])},
    }


def update_connection_settings(data: dict[str, Any]) -> dict[str, Any]:
    """Update only the requested connection block.

    Connection cards are saved independently in the UI. Validating and writing
    the complete server profile here made to valid BlueMap or squaremap URL fail
    whenever an unrelated legacy Crafty field contained an invalid value. Keep
    each partial save isolated so one integration cannot block another.
    """
    profile = server_profile_config(current_server_id())
    profile_id = int(profile["id"])
    connection_type = str(data.get("type", "")).strip().lower()
    timestamp = now_ts()

    if connection_type == "plugin":
        current = profile["plugin"]
        enabled = bool(data.get("enabled", current["enabled"]))
        api_raw = str(data.get("apiUrl", current["apiUrl"])).strip()
        api_url = validate_connection_url(api_raw, "Plugin address", direct_scheme="http", direct_port=8765) if api_raw else ""
        supplied_token = str(data.get("apiToken") or "").strip()
        supplied_access_secret = str(data.get("accessClientSecret") or "")
        api_token = supplied_token or current["apiToken"]
        access_client_id = str(data.get("accessClientId", current.get("accessClientId", ""))).strip()
        access_client_secret = supplied_access_secret or current.get("accessClientSecret", "")
        if bool(access_client_id) != bool(access_client_secret):
            raise ValueError("Configure both Cloudflare Access service-token values for the plugin")
        verify_tls = bool(data.get("verifyTls", current["verifyTls"]))
        if enabled and not api_url:
            raise ValueError("Enter the plugin URL")
        if enabled and not api_token:
            raise ValueError("Enter the plugin API token")
        if supplied_token and len(supplied_token) < 32:
            raise ValueError("The plugin token must contain at least 32 characters")
        encrypted_token = _encrypt_profile_secret(api_token)
        with db_connect() as db:
            cursor = db.execute(
                "UPDATE server_profiles SET plugin_enabled=?, plugin_api_url=?, "
                "plugin_token=?, plugin_verify_tls=?, plugin_access_client_id=?, "
                "plugin_access_client_secret=?, updated_at=? WHERE id=? AND active=1",
                (
                    1 if enabled else 0,
                    api_url,
                    encrypted_token,
                    1 if verify_tls else 0,
                    access_client_id,
                    _encrypt_profile_secret(access_client_secret),
                    timestamp,
                    profile_id,
                ),
            )
            if cursor.rowcount == 0:
                raise ValueError("Server not found")

    elif connection_type == "crafty":
        current = profile["crafty"]
        enabled = bool(data.get("enabled", current["enabled"]))
        connection_id = int(data.get("connectionId", current.get("connectionId", 0)) or 0)
        server_id = str(data.get("serverId", current["serverId"])).strip()
        shared = crafty_connection_config(connection_id) if connection_id else None

        if shared:
            api_url = shared["apiUrl"]
            panel_url = shared["panelUrl"]
            username = shared["username"]
            password = shared["password"]
            api_token = shared["apiToken"]
            verify_tls = shared["verifyTls"]
        else:
            api_raw = str(data.get("apiUrl", current["apiUrl"])).strip()
            panel_raw = str(data.get("panelUrl", current["panelUrl"])).strip()
            api_url = (
                validate_connection_url(api_raw, "Crafty address", direct_scheme="https", direct_port=8443)
                if api_raw and (enabled or "apiUrl" in data)
                else api_raw.rstrip("/")
            )
            panel_url = (
                validate_connection_url(panel_raw, "Public Crafty address", direct_scheme="https", direct_port=8443)
                if panel_raw and (enabled or "panelUrl" in data)
                else panel_raw.rstrip("/")
            )
            username = str(data.get("username", current["username"])).strip()
            supplied_password = str(data.get("password") or "")
            supplied_token = str(data.get("apiToken") or "").strip()
            password = supplied_password or current["password"]
            api_token = supplied_token or current["apiToken"]
            verify_tls = bool(data.get("verifyTls", current["verifyTls"]))

        if enabled and not server_id:
            raise ValueError("Enter the Crafty server ID")
        if enabled and not api_url:
            raise ValueError("Enter the Crafty URL")
        if enabled and not api_token and not (username and password):
            raise ValueError("Select to Crafty installation or configure credentials")

        with db_connect() as db:
            cursor = db.execute(
                "UPDATE server_profiles SET crafty_enabled=?, crafty_connection_id=?, "
                "crafty_api_url=?, crafty_username=?, crafty_password=?, crafty_api_token=?, "
                "crafty_server_id=?, crafty_panel_url=?, crafty_verify_tls=?, updated_at=? "
                "WHERE id=? AND active=1",
                (
                    1 if enabled else 0,
                    connection_id,
                    api_url,
                    username,
                    _encrypt_profile_secret(password),
                    _encrypt_profile_secret(api_token),
                    server_id,
                    panel_url,
                    1 if verify_tls else 0,
                    timestamp,
                    profile_id,
                ),
            )
            if cursor.rowcount == 0:
                raise ValueError("Server not found")

    elif connection_type == "bluemap":
        current = profile["blueMap"]
        enabled = bool(data.get("enabled", current["enabled"]))
        raw_url = str(data.get("url", current["url"])).strip()
        url = validate_connection_url(raw_url, "BlueMap address", direct_scheme="http") if raw_url else ""
        if enabled and not url:
            raise ValueError("Enter the public BlueMap URL")
        map_id = str(data.get("mapId", current["mapId"])).strip()[:128]
        with db_connect() as db:
            cursor = db.execute(
                "UPDATE server_profiles SET bluemap_enabled=?, bluemap_url=?, "
                "bluemap_map_id=?, updated_at=? WHERE id=? AND active=1",
                (1 if enabled else 0, url, map_id, timestamp, profile_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("Server not found")

    elif connection_type == "squaremap":
        current = profile["squareMap"]
        enabled = bool(data.get("enabled", current["enabled"]))
        raw_url = str(data.get("url", current["url"])).strip()
        url = validate_connection_url(raw_url, "squaremap address", direct_scheme="http") if raw_url else ""
        if enabled and not url:
            raise ValueError("Enter the public squaremap URL")
        world_id = str(
            data.get("worldId", current["worldId"] or "minecraft:overworld")
        ).strip()[:128] or "minecraft:overworld"
        with db_connect() as db:
            cursor = db.execute(
                "UPDATE server_profiles SET squaremap_enabled=?, squaremap_url=?, "
                "squaremap_world_id=?, updated_at=? WHERE id=? AND active=1",
                (1 if enabled else 0, url, world_id, timestamp, profile_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("Server not found")

    else:
        raise ValueError("Invalid connection type")

    reset_server_runtime(profile_id)
    return connection_settings_public(profile_id)


def backend_find_metric(value: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(value, dict):
        return None
    for key in keys:
        if key in value and value[key] is not None:
            return value[key]
    for child in value.values():
        if isinstance(child, dict):
            found = backend_find_metric(child, keys)
            if found is not None:
                return found
    return None


def numeric_metric(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def crafty_running(stats: dict[str, Any]) -> bool:
    raw = backend_find_metric(stats, ("running", "server_running"))
    if isinstance(raw, bool):
        return raw
    return str(raw or "").lower() in {"true", "running", "online", "started", "1"}


def crafty_uptime_seconds(stats: dict[str, Any]) -> int | None:
    direct = numeric_metric(backend_find_metric(stats, ("uptime", "up_time")))
    if direct is not None and direct > 0:
        return int(direct)
    started = backend_find_metric(stats, ("started", "start_time", "started_at", "start_date"))
    if not started or not crafty_running(stats):
        return None
    text = str(started).strip().replace(" ", "T")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?", text):
        text += "+00:00"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds()))
    except ValueError:
        return None


def row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}

def timestamp_seconds(value: Any) -> int:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0
    if number <= 0:
        return 0
    return int(number / 1000) if number > 100_000_000_000 else int(number)


def enrich_player_history(path: str, payload: bytes) -> bytes:
    if path != "/api/v1/players/all" and not re.fullmatch(r"/api/v1/players/[0-9a-fA-F-]{36}", path):
        return payload
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return payload
    if not isinstance(decoded, dict):
        return payload
    if path == "/api/v1/players/all":
        players = decoded.get("players")
        if not isinstance(players, list):
            return payload
    else:
        player = decoded.get("player")
        players = [player] if isinstance(player, dict) else []
    if not players:
        return payload

    with db_connect() as db:
        for player in players:
            if not isinstance(player, dict):
                continue
            uuid = str(player.get("uuid") or "").strip()
            name = str(player.get("player") or player.get("name") or player.get("displayName") or "").strip()
            row = None
            if uuid:
                row = db.execute(
                    "SELECT MIN(joined_at) AS first_seen, MAX(COALESCE(left_at,last_seen,joined_at)) AS last_seen "
                    "FROM sessions WHERE server_id=? AND lower(player_uuid)=lower(?)",
                    (current_server_id(), uuid),
                ).fetchone()
            if (not row or not row["last_seen"]) and name:
                row = db.execute(
                    "SELECT MIN(joined_at) AS first_seen, MAX(COALESCE(left_at,last_seen,joined_at)) AS last_seen "
                    "FROM sessions WHERE server_id=? AND lower(player_name)=lower(?)",
                    (current_server_id(), name),
                ).fetchone()
            if not row or not row["last_seen"]:
                continue
            db_first = int(row["first_seen"] or 0)
            db_last = int(row["last_seen"] or 0)
            current_first = timestamp_seconds(player.get("firstPlayed"))
            current_last = timestamp_seconds(player.get("lastPlayed"))
            first_candidates = [value for value in (current_first, db_first) if value > 0]
            if first_candidates:
                player["firstPlayed"] = min(first_candidates)
            player["lastPlayed"] = max(current_last, db_last)
            player["hasPlayedBefore"] = True
    return json.dumps(decoded, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def record_audit(
    category: str,
    action: str,
    result: str,
    *,
    actor: str = "system",
    player_uuid: str | None = None,
    player_name: str | None = None,
    details: dict[str, Any] | str | None = None,
    request_ip: str | None = None,
) -> None:
    encoded = details if isinstance(details, str) else json.dumps(details or {}, ensure_ascii=False, separators=(",", ":"))
    with db_connect() as db:
        db.execute(
            "INSERT INTO audit(server_id, ts, category, action, actor, player_uuid, player_name, details, result, request_ip) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (current_server_id(), now_ts(), category, action, actor, player_uuid, player_name, encoded, result, request_ip),
        )


class LiveEventBroker:
    def __init__(self, max_events: int = 250) -> None:
        self.condition = threading.Condition(threading.RLock())
        self.sequence = 0
        self.events: deque[dict[str, Any]] = deque(maxlen=max_events)

    def current_id(self) -> int:
        with self.condition:
            return self.sequence

    def publish(self, event_type: str, payload: dict[str, Any]) -> int:
        with self.condition:
            self.sequence += 1
            server_id = current_server_id()
            event = {
                "id": self.sequence,
                "event": event_type,
                "ts": now_ts(),
                "serverId": server_id,
                "payload": {**dict(payload), "serverId": server_id},
            }
            self.events.append(event)
            self.condition.notify_all()
            return self.sequence

    def wait_after(self, event_id: int, timeout: float) -> list[dict[str, Any]]:
        with self.condition:
            if self.sequence <= event_id:
                self.condition.wait(timeout=max(0.1, timeout))
            return [dict(item) for item in self.events if int(item.get("id") or 0) > event_id]


LIVE_EVENTS = LiveEventBroker()


def record_alert(
    alert_type: str,
    severity: str,
    title: str,
    message: str,
    player_uuid: str | None = None,
    *,
    dedupe_seconds: int = 0,
) -> int:
    timestamp = now_ts()
    server_id = current_server_id()
    with ALERT_LOCK:
        with db_connect() as db:
            if dedupe_seconds > 0:
                existing = db.execute(
                    "SELECT id FROM alerts WHERE server_id=? AND type=? AND COALESCE(player_uuid,'')=COALESCE(?,'') "
                    "AND title=? AND message=? AND ts>=? ORDER BY id DESC LIMIT 1",
                    (server_id, alert_type, player_uuid, title, message, timestamp - dedupe_seconds),
                ).fetchone()
                if existing:
                    return int(existing["id"])
            cursor = db.execute(
                "INSERT INTO alerts(server_id, ts, type, severity, title, message, player_uuid) VALUES(?,?,?,?,?,?,?)",
                (server_id, timestamp, alert_type, severity, title, message, player_uuid),
            )
            alert_id = int(cursor.lastrowid)
        alert_payload = {
            "id": alert_id,
            "ts": timestamp,
            "type": alert_type,
            "severity": severity,
            "title": title,
            "message": message,
            "player_uuid": player_uuid,
            "is_read": 0,
            "serverId": server_id,
            "serverName": server_profile_config(server_id)["name"],
        }
        LIVE_EVENTS.publish("alert", alert_payload)
        dispatcher = PUSH_DISPATCHER
        if dispatcher is not None:
            dispatcher.enqueue({
                "id": alert_id,
                "type": alert_type,
                "severity": severity,
                "title": title,
                "message": message,
                "playerUuid": player_uuid,
                "ts": timestamp,
                "serverId": server_id,
                "serverName": server_profile_config(server_id)["name"],
            })
        return alert_id


def parse_json_bytes(body: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def ensure_vapid_keys() -> str:
    """Create to persistent P-256 VAPID key and return the browser public key."""
    if VAPID_PRIVATE_KEY_PATH.is_file():
        private_key = serialization.load_pem_private_key(VAPID_PRIVATE_KEY_PATH.read_bytes(), password=None)
    else:
        private_key = ec.generate_private_key(ec.SECP256R1())
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        VAPID_PRIVATE_KEY_PATH.write_bytes(private_pem)
        os.chmod(VAPID_PRIVATE_KEY_PATH, 0o600)
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise RuntimeError("Invalid VAPID private key")
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return b64url(public_bytes)


def vapid_public_key_id(public_key: str) -> str:
    """Return to short non-secret fingerprint for VAPID continuity checks."""
    return hashlib.sha256(b64url_decode(public_key)).hexdigest()[:16]


def normalize_push_events(value: Any) -> list[str]:
    values = value if isinstance(value, list) else []
    clean = sorted({str(item) for item in values if str(item) in PUSH_EVENT_TYPES})
    return clean or sorted(PUSH_DEFAULT_EVENTS)


def push_route(alert_type: str, player_uuid: str | None = None, server_id: Any = None) -> str:
    server_suffix = f"&server={int(server_id)}" if server_id else ""
    if alert_type in {"join", "leave", "death", "low_food", "whitelist_denied"}:
        player_suffix = f"&player={quote(player_uuid, safe='-')}" if player_uuid else ""
        return f"/?view=players{server_suffix}{player_suffix}"
    if alert_type in {"server_down", "server_up", "backup_requested", "server_action", "crafty_down", "crafty_up"}:
        return f"/?view=server{server_suffix}"
    if alert_type in {"high_cpu", "high_memory", "low_tps", "high_storage", "metrics_recovered"}:
        return f"/?view=metrics{server_suffix}"
    return f"/?server={int(server_id)}" if server_id else "/"


class PushDispatcher:
    def __init__(self) -> None:
        self.queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=256)
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="player-panel-push", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass
        self.thread.join(timeout=5)

    def enqueue(self, alert: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(dict(alert))
        except queue.Full:
            logger.warning("Push queue is full; dropping alert %s", alert.get("id"))

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                alert = self.queue.get(timeout=1)
            except queue.Empty:
                continue
            if alert is None:
                break
            try:
                self.send_alert(alert)
            except Exception:
                logger.exception("Web Push delivery failed")

    def send_alert(self, alert: dict[str, Any]) -> None:
        alert_type = str(alert.get("type") or "test")
        payload = json.dumps({
            "title": str(alert.get("title") or "Player Panel"),
            "body": str(alert.get("message") or "There is to new alert."),
            "icon": "/icons/icon-192.png",
            "badge": "/icons/icon-192.png",
            "tag": f"player-panel-{alert_type}-{alert.get('id', 'event')}",
            "url": push_route(alert_type, alert.get("playerUuid"), alert.get("serverId")),
            "type": alert_type,
            "severity": str(alert.get("severity") or "info"),
            "alertId": alert.get("id"),
            "timestamp": int(alert.get("ts") or now_ts()) * 1000,
        }, ensure_ascii=False, separators=(",", ":"))
        target_user_id = int(alert.get("targetUserId") or 0)
        with db_connect() as db:
            if target_user_id:
                rows = db.execute("SELECT * FROM push_subscriptions WHERE enabled=1 AND user_id=?", (target_user_id,)).fetchall()
            else:
                rows = db.execute("SELECT * FROM push_subscriptions WHERE enabled=1").fetchall()
        for row in rows:
            try:
                events = set(json.loads(row["event_types_json"] or "[]"))
            except json.JSONDecodeError:
                events = set(PUSH_DEFAULT_EVENTS)
            if alert_type != "test" and alert_type not in events:
                continue
            subscription = {
                "endpoint": row["endpoint"],
                "keys": {"p256dh": row["p256dh"], "auth": row["auth"]},
            }
            try:
                stored_key_id = str(row["vapid_key_id"] or "") if "vapid_key_id" in row.keys() else ""
                if stored_key_id and VAPID_PUBLIC_KEY_ID and stored_key_id != VAPID_PUBLIC_KEY_ID:
                    message = "Push authentication changed. Select Repair on this device."
                    with db_connect() as db:
                        db.execute(
                            "UPDATE push_subscriptions SET repair_required=1, last_error=?, updated_at=? WHERE id=?",
                            (message, now_ts(), int(row["id"])),
                        )
                    continue
                webpush(
                    subscription_info=subscription,
                    data=payload,
                    vapid_private_key=str(VAPID_PRIVATE_KEY_PATH),
                    vapid_claims={"sub": VAPID_SUBJECT},
                    ttl=PUSH_TTL,
                    timeout=PUSH_TIMEOUT,
                )
                with db_connect() as db:
                    db.execute(
                        "UPDATE push_subscriptions SET last_success=?, last_error=NULL, vapid_key_id=?, repair_required=0, updated_at=? WHERE id=?",
                        (now_ts(), VAPID_PUBLIC_KEY_ID, now_ts(), int(row["id"])),
                    )
            except WebPushException as exc:
                response = getattr(exc, "response", None)
                status = getattr(response, "status_code", None)
                response_text = str(getattr(response, "text", "") or "")
                raw_message = str(exc)[:500]
                bad_jwt = status == 403 and "BadJwtToken" in f"{response_text} {raw_message}"
                if status in {404, 410}:
                    with db_connect() as db:
                        db.execute("DELETE FROM push_subscriptions WHERE id=?", (int(row["id"]),))
                elif bad_jwt:
                    message = "Push authentication must be renewed. Select Repair on this device."
                    with db_connect() as db:
                        db.execute(
                            "UPDATE push_subscriptions SET repair_required=1, last_error=?, updated_at=? WHERE id=?",
                            (message, now_ts(), int(row["id"])),
                        )
                    logger.warning("Push VAPID rejected for subscription %s: %s", row["id"], raw_message)
                else:
                    with db_connect() as db:
                        db.execute(
                            "UPDATE push_subscriptions SET last_error=?, updated_at=? WHERE id=?",
                            (raw_message, now_ts(), int(row["id"])),
                        )
                    logger.warning("Push failed for subscription %s: %s", row["id"], raw_message)


VAPID_PUBLIC_KEY = ""
VAPID_PUBLIC_KEY_ID = ""
PUSH_DISPATCHER: PushDispatcher | None = None


def password_digest(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    if not isinstance(password, str) or len(password) < 10:
        raise ValueError("The password must contain at least 10 characters")
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ROUNDS)
    return salt.hex(), digest.hex()


def verify_password(password: str, salt_hex: str, expected_hex: str) -> bool:
    try:
        _, actual = password_digest(password, salt_hex)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected_hex)


def permission_set(user: dict[str, Any] | sqlite3.Row) -> set[str]:
    role = str(user["role"] if isinstance(user, sqlite3.Row) else user.get("role", "viewer"))
    base = set(ROLE_PERMISSIONS.get(role, ROLE_PERMISSIONS["viewer"]))
    if "*" in base:
        return {"*"}
    raw = user["permissions_json"] if isinstance(user, sqlite3.Row) else user.get("permissions_json", "{}")
    try:
        overrides = json.loads(raw or "{}") if isinstance(raw, str) else (raw or {})
    except json.JSONDecodeError:
        overrides = {}
    for name in overrides.get("allow", []):
        if name in ALL_PERMISSIONS:
            base.add(name)
    for name in overrides.get("deny", []):
        base.discard(name)
    return base


def user_can(user: dict[str, Any] | sqlite3.Row, permission: str) -> bool:
    perms = permission_set(user)
    return "*" in perms or permission in perms


def normalize_dashboard_layout(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    try:
        source_version = max(0, int(raw.get("version", 0)))
    except (TypeError, ValueError):
        source_version = 0
    requested_order = raw.get("order", [])
    requested_hidden = raw.get("hidden", [])
    requested_sizes = raw.get("sizes", {}) if isinstance(raw.get("sizes", {}), dict) else {}
    order: list[str] = []
    if isinstance(requested_order, list):
        for item in requested_order:
            widget_id = str(item).strip()
            if widget_id in DASHBOARD_WIDGET_ID_SET and widget_id not in order:
                order.append(widget_id)
    for widget_id in DASHBOARD_WIDGET_IDS:
        if widget_id not in order:
            order.append(widget_id)
    hidden: list[str] = []
    if isinstance(requested_hidden, list):
        for item in requested_hidden:
            widget_id = str(item).strip()
            if widget_id in DASHBOARD_WIDGET_ID_SET and widget_id not in hidden:
                hidden.append(widget_id)
    if source_version < 3:
        for widget_id in DASHBOARD_OPTIONAL_WIDGET_IDS:
            if widget_id not in hidden:
                hidden.append(widget_id)
    if source_version < 4 and "recent-sessions" not in hidden:
        hidden.append("recent-sessions")
    sizes: dict[str, dict[str, int]] = {}
    for widget_id in DASHBOARD_WIDGET_IDS:
        kind = DASHBOARD_WIDGET_KINDS[widget_id]
        default = DASHBOARD_DEFAULT_SIZES[widget_id]
        item = requested_sizes.get(widget_id, {})
        if not isinstance(item, dict):
            item = {}
        min_cols = 6 if kind == "world" else 4 if kind == "panel" else 2
        try:
            cols = int(round(float(item.get("cols", default["cols"]))))
        except (TypeError, ValueError):
            cols = int(default["cols"])
        cols = max(min_cols, min(12, cols))
        try:
            height = int(round(float(item.get("height", default["height"]))))
        except (TypeError, ValueError):
            height = int(default["height"])
        min_height = 390 if kind == "world" else 240 if kind == "panel" else 112
        height = 0 if height <= 0 else max(min_height, min(900, height))
        sizes[widget_id] = {"cols": cols, "height": height}
    return {"version": 4, "order": order, "hidden": hidden, "sizes": sizes}


def dashboard_layout_for_user(user_id: int) -> dict[str, Any]:
    with db_connect() as db:
        row = db.execute(
            "SELECT value, updated_at FROM user_preferences WHERE user_id=? AND key='dashboard.layout'",
            (int(user_id),),
        ).fetchone()
    if not row:
        return {**normalize_dashboard_layout({}), "updatedAt": None}
    try:
        value = json.loads(str(row["value"] or "{}"))
    except json.JSONDecodeError:
        value = {}
    return {**normalize_dashboard_layout(value), "updatedAt": int(row["updated_at"])}


def save_dashboard_layout(user_id: int, value: Any) -> dict[str, Any]:
    layout = normalize_dashboard_layout(value)
    timestamp = now_ts()
    with db_connect() as db:
        db.execute(
            "INSERT INTO user_preferences(user_id, key, value, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (int(user_id), "dashboard.layout", json.dumps(layout, separators=(",", ":")), timestamp),
        )
    return {**layout, "updatedAt": timestamp}


def public_user(user: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    getter = (lambda k, d=None: user[k] if k in user.keys() else d) if isinstance(user, sqlite3.Row) else user.get
    return {
        "id": int(getter("id", 0)),
        "username": str(getter("username", "")),
        "displayName": str(getter("display_name", "")),
        "role": str(getter("role", "viewer")),
        "roleLabel": ROLE_LABELS.get(str(getter("role", "viewer")), "Read only"),
        "active": bool(getter("active", 0)),
        "totpEnabled": bool(getter("totp_enabled", 0)),
        "lastLogin": getter("last_login"),
        "permissions": sorted(permission_set(user)),
    }


def normalize_ip_address(value: str | None) -> str:
    """Return to canonical IP address or an empty string for invalid input."""
    raw = str(value or "").strip().strip('\"').strip("'")
    if not raw or raw.lower() in {"unknown", "null", "none"}:
        return ""
    if raw.lower().startswith("for="):
        raw = raw[4:].strip().strip('\"').strip("'")
    # RFC 7239 uses [IPv6]:port. Common proxies also send IPv4:port.
    if raw.startswith("[") and "]" in raw:
        raw = raw[1:raw.index("]")]
    elif raw.count(":") == 1 and raw.rsplit(":", 1)[1].isdigit():
        raw = raw.rsplit(":", 1)[0]
    if "%" in raw:  # IPv6 zone identifiers are not useful outside the local host.
        raw = raw.split("%", 1)[0]
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return ""
    if address.is_unspecified or address.is_multicast:
        return ""
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return str(address.ipv4_mapped)
    return str(address)


def proxy_peer_is_trusted(peer_ip: str) -> bool:
    if not TRUST_PROXY:
        return False
    normalized = normalize_ip_address(peer_ip)
    if not normalized:
        return False
    # Empty list preserves the historical TRUST_PROXY=true behavior. New installs
    # write the Docker network explicitly to avoid trusting arbitrary clients.
    if not TRUSTED_PROXY_NETWORKS:
        return True
    address = ipaddress.ip_address(normalized)
    return any(address.version == network.version and address in network for network in TRUSTED_PROXY_NETWORKS)


def forwarded_header_ip(value: str | None) -> str:
    """Parse the first valid `for=` address from an RFC 7239 Forwarded header."""
    for element in str(value or "").split(","):
        for parameter in element.split(";"):
            name, separator, raw = parameter.strip().partition("=")
            if separator and name.strip().lower() == "for":
                candidate = normalize_ip_address(raw)
                if candidate:
                    return candidate
    return ""


def create_session(user: sqlite3.Row, ip: str, user_agent: str) -> tuple[str, str]:
    raw_token = secrets.token_urlsafe(36)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    csrf = secrets.token_urlsafe(24)
    now = now_ts()
    with db_connect() as db:
        db.execute(
            "INSERT INTO web_sessions(token_hash, user_id, csrf, session_version, created_at, last_seen, expires_at, ip, user_agent) VALUES(?,?,?,?,?,?,?,?,?)",
            (token_hash, int(user["id"]), csrf, int(user["session_version"]), now, now, now + SESSION_TTL, ip, user_agent[:300]),
        )
    return raw_token, csrf


def validate_session(value: str | None, current_ip: str = "") -> dict[str, Any] | None:
    if not value:
        return None
    token_hash = hashlib.sha256(value.encode("utf-8")).hexdigest()
    normalized_current_ip = normalize_ip_address(current_ip)
    with db_connect() as db:
        row = db.execute(
            "SELECT ws.*, u.id AS id, u.username, u.display_name, u.role, u.permissions_json, u.active, u.totp_enabled, u.last_login, u.session_version AS current_session_version "
            "FROM web_sessions ws JOIN users u ON u.id=ws.user_id WHERE ws.token_hash=?",
            (token_hash,),
        ).fetchone()
        if not row or not row["active"] or int(row["expires_at"]) < now_ts() or int(row["session_version"]) != int(row["current_session_version"]):
            if row:
                db.execute("DELETE FROM web_sessions WHERE token_hash=?", (token_hash,))
            return None
        if normalized_current_ip and normalized_current_ip != str(row["ip"] or ""):
            db.execute("UPDATE web_sessions SET last_seen=?, ip=? WHERE token_hash=?", (now_ts(), normalized_current_ip, token_hash))
        else:
            db.execute("UPDATE web_sessions SET last_seen=? WHERE token_hash=?", (now_ts(), token_hash))
        data = row_dict(row)
        if normalized_current_ip:
            data["ip"] = normalized_current_ip
        data["token_hash"] = token_hash
        data["permissions"] = sorted(permission_set(data))
        return data


def delete_session(value: str | None) -> None:
    if not value:
        return
    with db_connect() as db:
        db.execute("DELETE FROM web_sessions WHERE token_hash=?", (hashlib.sha256(value.encode("utf-8")).hexdigest(),))


def totp_code(secret_b32: str, timestamp: int | None = None) -> str:
    normalized = re.sub(r"[^A-Z2-7]", "", secret_b32.upper())
    key = base64.b32decode(normalized + "=" * (-len(normalized) % 8))
    counter = int(timestamp or time.time()) // 30
    digest = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def verify_totp(secret_b32: str, supplied: str) -> bool:
    code = re.sub(r"\D", "", supplied or "")
    if len(code) != 6:
        return False
    current = int(time.time())
    return any(hmac.compare_digest(totp_code(secret_b32, current + drift * 30), code) for drift in (-1, 0, 1))


UPSTREAM_CACHE_LOCK = threading.RLock()
UPSTREAM_GET_CACHE: dict[tuple[int, str], tuple[float, int, bytes]] = {}
UPSTREAM_INFLIGHT: dict[tuple[int, str], threading.Event] = {}
UPSTREAM_RATE_LIMITED_UNTIL: dict[int, float] = defaultdict(float)
UPSTREAM_STALE_MAX_SECONDS = max(30, int(os.getenv("UPSTREAM_STALE_MAX_SECONDS", "120")))
UPSTREAM_RATE_LIMIT_FALLBACK_SECONDS = max(1, int(os.getenv("UPSTREAM_RATE_LIMIT_FALLBACK_SECONDS", "5")))


def upstream_cache_ttl(path: str) -> float:
    if path == "/api/v1/health":
        return 2.0
    if path in {"/api/v1/server", "/api/v1/players"}:
        return 4.0
    if path == "/api/v1/metrics":
        return 10.0
    if path in {"/api/v1/players/all", "/api/v1/whitelist", "/api/v1/bans"}:
        return 15.0
    if re.fullmatch(r"/api/v1/players/[0-9a-fA-F-]{36}/inventory", path):
        return 1.25
    if re.fullmatch(r"/api/v1/players/[0-9a-fA-F-]{36}", path):
        return 3.0
    return 0.0


def upstream_rate_limit_payload(retry_after: int) -> bytes:
    return json.dumps({
        "success": False,
        "error": "UPSTREAM_RATE_LIMITED",
        "message": "The Minecraft API temporarily reached its limit. The panel will retry automatically.",
        "retryAfter": retry_after,
    }, ensure_ascii=False).encode("utf-8")


def upstream_retry_after(headers: Any) -> int:
    try:
        value = str(headers.get("Retry-After", "")).strip()
        if value:
            return max(1, min(int(float(value)), 60))
    except (TypeError, ValueError):
        pass
    return UPSTREAM_RATE_LIMIT_FALLBACK_SECONDS


def upstream_request(
    method: str,
    path: str,
    body: bytes | None = None,
    *,
    quiet: bool = False,
    server_id: Any = None,
) -> tuple[int, bytes]:
    sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    config = server_profile_config(sid)
    plugin = config["plugin"]
    api_url = str(plugin.get("apiUrl") or "").rstrip("/")
    api_token = str(plugin.get("apiToken") or "")
    if not plugin.get("enabled") or not api_url or not api_token:
        payload = json.dumps({
            "success": False,
            "error": "PLUGIN_NOT_CONFIGURED",
            "message": f"The plugin connection is not configured for {config['name']}",
        }, ensure_ascii=False).encode("utf-8")
        return HTTPStatus.PRECONDITION_FAILED, payload

    method = method.upper()
    cacheable = method == "GET" and path != "/api/v1/events"
    cache_ttl = upstream_cache_ttl(path) if cacheable else 0.0
    owns_request = False
    request_event: threading.Event | None = None
    cache_key = (sid, path)

    if method == "GET":
        while True:
            now_mono = time.monotonic()
            with UPSTREAM_CACHE_LOCK:
                cached = UPSTREAM_GET_CACHE.get(cache_key)
                limited_until = UPSTREAM_RATE_LIMITED_UNTIL.get(sid, 0.0)
                if cacheable and cached and cache_ttl > 0 and now_mono - cached[0] <= cache_ttl:
                    return cached[1], cached[2]
                if now_mono < limited_until:
                    if cacheable and cached and now_mono - cached[0] <= UPSTREAM_STALE_MAX_SECONDS:
                        return cached[1], cached[2]
                    retry_after = max(1, int(limited_until - now_mono + 0.999))
                    return HTTPStatus.TOO_MANY_REQUESTS, upstream_rate_limit_payload(retry_after)
                if not cacheable:
                    break
                request_event = UPSTREAM_INFLIGHT.get(cache_key)
                if request_event is None:
                    request_event = threading.Event()
                    UPSTREAM_INFLIGHT[cache_key] = request_event
                    owns_request = True
                    break
            request_event.wait(timeout=UPSTREAM_TIMEOUT + 1.0)

    headers = {
        "Authorization": f"Bearer {api_token}",
        "Accept": "application/json",
        "User-Agent": f"PlayerPanelWeb/{APP_VERSION}",
    }
    headers.update(access_proxy_headers(plugin))
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(api_url + path, data=body, headers=headers, method=method)
    tls_context = None if plugin.get("verifyTls", True) else ssl._create_unverified_context()  # noqa: SLF001
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT, context=tls_context) as response:
            status = response.status
            response_body = response.read()
            with UPSTREAM_CACHE_LOCK:
                if cacheable and status == HTTPStatus.OK:
                    UPSTREAM_GET_CACHE[cache_key] = (time.monotonic(), int(status), response_body)
                elif method != "GET" and status < 400:
                    for key in [key for key in UPSTREAM_GET_CACHE if key[0] == sid]:
                        UPSTREAM_GET_CACHE.pop(key, None)
            return status, response_body
    except urllib.error.HTTPError as exc:
        response_body = exc.read()
        response_headers = safe_response_headers(exc.headers)
        response_text = response_body.decode("utf-8", errors="replace").lower()
        if exc.code in {HTTPStatus.FORBIDDEN, HTTPStatus.UNAUTHORIZED} and (
            response_headers.get("cf-ray") or "cloudflare" in response_headers.get("server", "").lower()
            or "cloudflare access" in response_text
        ):
            payload = json.dumps({
                "success": False,
                "error": "CLOUDFLARE_ACCESS_DENIED",
                "message": "Cloudflare rejected the plugin connection.",
                "diagnostic": {
                    "category": "cloudflare-access",
                    "detail": f"The proxy returned HTTP {exc.code}",
                    "hint": "Use a direct IP address or a private network/VPN, or adjust the domain security rule.",
                    "target": connection_url_metadata(api_url),
                },
            }, ensure_ascii=False).encode("utf-8")
            return HTTPStatus.BAD_GATEWAY, payload
        if exc.code == HTTPStatus.TOO_MANY_REQUESTS:
            retry_after = upstream_retry_after(exc.headers)
            now_mono = time.monotonic()
            with UPSTREAM_CACHE_LOCK:
                UPSTREAM_RATE_LIMITED_UNTIL[sid] = max(UPSTREAM_RATE_LIMITED_UNTIL.get(sid, 0.0), now_mono + retry_after)
                cached = UPSTREAM_GET_CACHE.get(cache_key)
                if cacheable and cached and now_mono - cached[0] <= UPSTREAM_STALE_MAX_SECONDS:
                    return cached[1], cached[2]
            if not quiet:
                logger.warning("Upstream rate limited for %ss on server=%s path=%s", retry_after, sid, path)
            return HTTPStatus.TOO_MANY_REQUESTS, upstream_rate_limit_payload(retry_after)
        if exc.code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}:
            payload = json.dumps({
                "success": False,
                "error": "PLUGIN_AUTH_FAILED",
                "message": f"The plugin for {config['name']} rejected the API token.",
                "upstreamStatus": exc.code,
            }, ensure_ascii=False).encode("utf-8")
            return HTTPStatus.BAD_GATEWAY, payload
        return exc.code, response_body
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        if not quiet:
            logger.warning("Upstream unavailable for server=%s: %s", sid, exc)
        diagnostic = connection_error_diagnostic(api_url, exc)
        target = diagnostic.get("target", {})
        if target.get("route") == "remote" and target.get("scheme") == "https" and int(target.get("port") or 0) == 8765:
            diagnostic["hint"] = (
                "The URL uses HTTPS on internal port 8765. If Nginx Proxy Manager or Cloudflare publishes the plugin on port 443, "
                f"use https://{target.get('host')} without :8765."
            )
        payload = json.dumps({
            "success": False,
            "error": "UPSTREAM_UNAVAILABLE",
            "message": f"The Minecraft API for {config['name']} is unavailable",
            "diagnostic": diagnostic,
        }, ensure_ascii=False).encode("utf-8")
        return HTTPStatus.BAD_GATEWAY, payload
    finally:
        if owns_request and request_event is not None:
            with UPSTREAM_CACHE_LOCK:
                UPSTREAM_INFLIGHT.pop(cache_key, None)
                request_event.set()


class CraftyClient:
    """Small Crafty v2 client bound to one server profile."""

    def __init__(self, server_id: int) -> None:
        self.server_id = resolve_server_id(server_id)
        self._lock = threading.RLock()
        self._token = str(server_profile_config(self.server_id)["crafty"].get("apiToken") or "")

    def config(self) -> dict[str, Any]:
        return server_profile_config(self.server_id)["crafty"]

    def configured(self) -> bool:
        config = self.config()
        return bool(
            config.get("enabled") and config.get("apiUrl") and config.get("serverId")
            and (self._token or config.get("apiToken") or (config.get("username") and config.get("password")))
        )

    def reset(self) -> None:
        with self._lock:
            self._token = str(self.config().get("apiToken") or "")

    def _context(self) -> ssl.SSLContext | None:
        return None if self.config().get("verifyTls") else ssl._create_unverified_context()  # noqa: SLF001

    @staticmethod
    def _decode(body: bytes) -> Any:
        if not body:
            return {}
        try:
            return json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"raw": body.decode("utf-8", errors="replace")}

    def _send(
        self,
        method: str,
        path: str,
        *,
        token: str = "",
        body: bytes | None = None,
        content_type: str = "application/json",
    ) -> tuple[int, Any]:
        config = self.config()
        headers = {
            "Accept": "application/json",
            "User-Agent": f"PlayerPanelWeb/{APP_VERSION}",
        }
        headers.update(access_proxy_headers(config))
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            str(config.get("apiUrl") or "").rstrip("/") + path,
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=CRAFTY_TIMEOUT,
                context=self._context(),
            ) as response:
                return response.status, attach_http_metadata(self._decode(response.read()), response.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, attach_http_metadata(self._decode(exc.read()), exc.headers)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            return HTTPStatus.BAD_GATEWAY, {
                "status": "error",
                "error": "CRAFTY_UNAVAILABLE",
                "error_data": str(exc),
                "diagnostic": connection_error_diagnostic(config.get("apiUrl", ""), exc),
            }

    def login(self) -> str:
        config = self.config()
        username = str(config.get("username") or "")
        password = str(config.get("password") or "")
        configured_token = str(config.get("apiToken") or "")
        # A dedicated API token is deterministic and does not depend on MFA,
        # browser sessions or password-login policies. Prefer it whenever set.
        if configured_token:
            self._token = configured_token
            return self._token
        if self._token:
            return self._token
        if not username or not password:
            raise CraftyAuthError(
                HTTPStatus.UNAUTHORIZED,
                "Crafty has no configured API token or username/password",
                {"category": "authentication", "hint": "Configure a dedicated Crafty API token."},
            )
        raw = json.dumps(
            {"username": username, "password": password},
            separators=(",", ":"),
        ).encode("utf-8")
        status, payload = self._send("POST", "/api/v2/auth/login", body=raw)
        token = ""
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, dict):
                token = str(data.get("token") or "")
        if not (200 <= int(status) < 300 and token):
            message, diagnostic = crafty_auth_failure_message(int(status), payload)
            raise CraftyAuthError(int(status), message, diagnostic)
        self._token = token
        return token

    def request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        text_body: str | None = None,
        retry_auth: bool = True,
    ) -> tuple[int, Any]:
        if not self.configured():
            return HTTPStatus.PRECONDITION_FAILED, {
                "status": "error",
                "error": "CRAFTY_NOT_CONFIGURED",
                "error_data": "Crafty integration is not configured",
            }
        with self._lock:
            try:
                token = self._token or self.login()
            except CraftyAuthError as exc:
                return exc.status, {
                    "status": "error",
                    "error": "CRAFTY_LOGIN_FAILED",
                    "error_data": str(exc),
                    "diagnostic": exc.diagnostic,
                }
            except RuntimeError as exc:
                return HTTPStatus.UNAUTHORIZED, {
                    "status": "error",
                    "error": "CRAFTY_LOGIN_FAILED",
                    "error_data": str(exc),
                }
        body: bytes | None = None
        content_type = "application/json"
        if payload is not None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        elif text_body is not None:
            body = text_body.encode("utf-8")
            content_type = "text/plain"
        elif method.upper() in {"POST", "PUT", "PATCH"}:
            body = b""
        status, data = self._send(method, path, token=token, body=body, content_type=content_type)
        error_code = str(data.get("error", "")) if isinstance(data, dict) else ""
        auth_failed = int(status) in {401, 403} or error_code in {
            "INVALID_TOKEN", "INVALID_AUTHENTICATION", "AUTHENTICATION_REQUIRED",
        }
        config = self.config()
        if auth_failed and retry_auth and config.get("username") and config.get("password"):
            with self._lock:
                self._token = ""
                try:
                    self.login()
                except (CraftyAuthError, RuntimeError):
                    return status, data
            return self.request(method, path, payload=payload, text_body=text_body, retry_auth=False)
        return status, data



class CraftyConnectionClient(CraftyClient):
    def __init__(self, connection_id: int) -> None:
        self.connection_id = int(connection_id)
        self._lock = threading.RLock()
        self._token = str(crafty_connection_config(self.connection_id).get("apiToken") or "")

    def config(self) -> dict[str, Any]:
        return crafty_connection_config(self.connection_id)

    def configured(self) -> bool:
        config = self.config()
        return bool(
            config.get("apiUrl")
            and (
                self._token
                or config.get("apiToken")
                or (config.get("username") and config.get("password"))
            )
        )


CRAFTY_CONNECTION_CLIENTS_LOCK = threading.RLock()
CRAFTY_CONNECTION_CLIENTS: dict[int, CraftyConnectionClient] = {}


def crafty_connection_client(connection_id: Any) -> CraftyConnectionClient:
    resolved = int(connection_id or 0)
    crafty_connection_config(resolved)
    with CRAFTY_CONNECTION_CLIENTS_LOCK:
        client = CRAFTY_CONNECTION_CLIENTS.get(resolved)
        if client is None:
            client = CraftyConnectionClient(resolved)
            CRAFTY_CONNECTION_CLIENTS[resolved] = client
        return client


def reset_crafty_connection_runtime(connection_id: Any = None) -> None:
    with CRAFTY_CONNECTION_CLIENTS_LOCK:
        if connection_id is None:
            CRAFTY_CONNECTION_CLIENTS.clear()
        else:
            CRAFTY_CONNECTION_CLIENTS.pop(int(connection_id), None)


def _crafty_server_candidates(value: Any) -> list[dict[str, Any]]:
    value = crafty_data(value)
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("servers", "items", "results"):
        nested = value.get(key)
        if isinstance(nested, list):
            return [item for item in nested if isinstance(item, dict)]
        if isinstance(nested, dict):
            return _crafty_server_candidates(nested)
    id_keys = {"server_id", "serverId", "uuid", "server_uuid", "id"}
    if id_keys.intersection(value):
        return [value]
    candidates = []
    for key, item in value.items():
        if not isinstance(item, dict):
            continue
        candidate = dict(item)
        if not id_keys.intersection(candidate):
            candidate.setdefault("server_id", str(key))
        candidates.append(candidate)
    return candidates


def normalize_crafty_servers(payload: Any) -> list[dict[str, Any]]:
    normalized = []
    seen: set[str] = set()
    for item in _crafty_server_candidates(payload):
        server_id = str(
            item.get("server_id") or item.get("serverId")
            or item.get("server_uuid") or item.get("uuid")
            or item.get("id") or ""
        ).strip()
        if not server_id or server_id in seen:
            continue
        seen.add(server_id)
        stats = item.get("stats") if isinstance(item.get("stats"), dict) else {}
        name = str(
            item.get("server_name") or item.get("name")
            or item.get("display_name") or item.get("serverName")
            or stats.get("server_name") or server_id
        ).strip()
        status_value = (
            item.get("status") or item.get("state")
            or item.get("server_state") or stats.get("status")
            or stats.get("state") or ""
        )
        running_value = (
            item.get("running") if item.get("running") is not None
            else item.get("online") if item.get("online") is not None
            else stats.get("running")
        )
        running = bool(running_value) if isinstance(running_value, bool) else (
            str(running_value).strip().lower()
            in {"1", "true", "yes", "online", "running"}
        )
        if not running and str(status_value).strip().lower() in {
            "running", "online", "started", "ready"
        }:
            running = True
        server_type = str(
            item.get("type") or item.get("server_type")
            or item.get("platform") or item.get("minecraft_type") or ""
        ).strip()
        normalized.append({
            "id": server_id[:128],
            "name": name[:120],
            "running": running,
            "status": str(status_value or ("running" if running else "unknown"))[:80],
            "type": server_type[:80],
        })
    normalized.sort(key=lambda item: (item["name"].lower(), item["id"]))
    return normalized


def discover_crafty_servers(connection_id: Any) -> dict[str, Any]:
    connection = public_crafty_connection(connection_id)
    client = crafty_connection_client(connection["id"])
    started = time.monotonic()
    status, response = client.request("GET", "/api/v2/servers")
    if int(status) == 404:
        status, response = client.request("GET", "/api/v2/servers/")
    latency = round((time.monotonic() - started) * 1000, 1)
    ok = 200 <= int(status) < 300
    servers = normalize_crafty_servers(response) if ok else []
    diagnostic = response.get("diagnostic", {}) if isinstance(response, dict) else {}
    message = ""
    if not ok and isinstance(response, dict):
        message = str(
            response.get("error_data") or response.get("message")
            or response.get("error") or ""
        )
    return {
        "available": ok,
        "status": int(status),
        "latencyMs": latency,
        "connection": connection,
        "servers": servers,
        "count": len(servers),
        "message": message,
        "diagnostic": diagnostic,
    }


def import_crafty_servers(connection_id: int, requested_ids: list[Any]) -> dict[str, Any]:
    discovery = discover_crafty_servers(connection_id)
    if not discovery["available"]:
        raise ValueError(discovery.get("message") or f"Crafty returned HTTP {discovery.get('status')}")
    requested = {str(value).strip() for value in requested_ids if str(value).strip()}
    available = {
        str(item["id"]): item for item in discovery["servers"]
        if not requested or str(item["id"]) in requested
    }
    if requested:
        missing = requested.difference(available)
        if missing:
            raise ValueError("Crafty did not return these servers: " + ", ".join(sorted(missing)))
    imported, skipped = [], []
    for crafty_id, item in available.items():
        with db_connect() as db:
            existing = db.execute(
                "SELECT id, name FROM server_profiles "
                "WHERE active=1 AND crafty_connection_id=? AND crafty_server_id=? LIMIT 1",
                (int(connection_id), crafty_id),
            ).fetchone()
        if existing:
            skipped.append({"id": int(existing["id"]), "name": str(existing["name"]), "craftyServerId": crafty_id})
            continue
        base_name = str(item.get("name") or f"Server {crafty_id}").strip()[:80]
        candidate = base_name
        suffix = 2
        with db_connect() as db:
            while db.execute(
                "SELECT 1 FROM server_profiles WHERE name=? COLLATE NOCASE AND active=1",
                (candidate,),
            ).fetchone():
                candidate = f"{base_name[:70]} {suffix}"
                suffix += 1
        profile = save_server_profile({
            "name": candidate,
            "isDefault": False,
            "sourceType": "crafty",
            "plugin": {"enabled": False, "apiUrl": "http://crafty-controller:8765", "apiToken": "", "verifyTls": True},
            "crafty": {"enabled": True, "connectionId": int(connection_id), "serverId": crafty_id},
            "blueMap": {"enabled": False, "url": "", "mapId": ""},
            "squareMap": {"enabled": False, "url": "", "worldId": "minecraft:overworld"},
        })
        imported.append(profile)
    return {
        "imported": imported,
        "skipped": skipped,
        "discovery": discovery,
        "servers": list_server_profiles_public(),
    }



CRAFTY_CLIENTS_LOCK = threading.RLock()
CRAFTY_CLIENTS: dict[int, CraftyClient] = {}


def crafty_client(server_id: Any = None) -> CraftyClient:
    sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    with CRAFTY_CLIENTS_LOCK:
        client = CRAFTY_CLIENTS.get(sid)
        if client is None:
            client = CraftyClient(sid)
            CRAFTY_CLIENTS[sid] = client
        return client


def reset_server_runtime(server_id: Any = None) -> None:
    if server_id is None:
        ids = list(CRAFTY_CLIENTS.keys())
    else:
        ids = [resolve_server_id(server_id, active_only=False)]
    with CRAFTY_CLIENTS_LOCK:
        for sid in ids:
            CRAFTY_CLIENTS.pop(sid, None)
    with UPSTREAM_CACHE_LOCK:
        if server_id is None:
            UPSTREAM_GET_CACHE.clear(); UPSTREAM_INFLIGHT.clear(); UPSTREAM_RATE_LIMITED_UNTIL.clear()
        else:
            sid = ids[0]
            for key in [key for key in UPSTREAM_GET_CACHE if key[0] == sid]:
                UPSTREAM_GET_CACHE.pop(key, None)
            UPSTREAM_RATE_LIMITED_UNTIL.pop(sid, None)
    cache = globals().get("CRAFTY_OVERVIEW_CACHE")
    if cache is not None:
        try:
            cache.clear(server_id)
        except Exception:
            pass


def crafty_request(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    text_body: str | None = None,
    server_id: Any = None,
) -> tuple[int, Any]:
    return crafty_client(server_id).request(method, path, payload=payload, text_body=text_body)


def crafty_data(payload: Any) -> Any:
    if isinstance(payload, dict) and "data" in payload:
        return payload.get("data")
    return payload


class CraftyOverviewCache:
    """Shared, stale-safe Crafty snapshots keyed by server profile."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.states: dict[int, dict[str, Any]] = {}

    @staticmethod
    def clone(value: dict[str, Any]) -> dict[str, Any]:
        return json.loads(json.dumps(value, ensure_ascii=False)) if value else {}

    def _state(self, server_id: int) -> dict[str, Any]:
        with self.lock:
            return self.states.setdefault(server_id, {
                "snapshot": {},
                "refreshed": 0.0,
                "serverRefreshed": 0.0,
                "refreshing": False,
            })

    def clear(self, server_id: Any = None) -> None:
        with self.lock:
            if server_id is None:
                self.states.clear()
            else:
                self.states.pop(resolve_server_id(server_id, active_only=False), None)

    def invalidate(self, server_id: Any = None) -> None:
        sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
        state = self._state(sid)
        with self.lock:
            state["refreshed"] = 0.0

    def get(self, *, force: bool = False, server_id: Any = None) -> dict[str, Any]:
        sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
        state = self._state(sid)
        now_mono = time.monotonic()
        with self.lock:
            snapshot = self.clone(state["snapshot"])
            refreshed = float(state["refreshed"] or 0.0)
            age = now_mono - refreshed if refreshed else float("inf")
            if snapshot and not force and age < CRAFTY_SUMMARY_CACHE_SECONDS:
                snapshot["ageSeconds"] = max(0.0, round(age, 2))
                return snapshot
            if state["refreshing"] and snapshot:
                snapshot["refreshing"] = True
                snapshot["stale"] = True
                snapshot["ageSeconds"] = max(0.0, round(age, 2))
                return snapshot
            state["refreshing"] = True
            previous = snapshot
            previous_age = age
            need_server = force or not previous.get("server") or now_mono - float(state["serverRefreshed"] or 0.0) >= CRAFTY_SERVER_CACHE_SECONDS
        try:
            fresh = crafty_status(sid)
            config = server_profile_config(sid)["crafty"]
            if fresh.get("available"):
                if need_server:
                    server_path = quote(str(config.get("serverId") or ""), safe="-")
                    status, response = crafty_request("GET", f"/api/v2/servers/{server_path}", server_id=sid)
                    if 200 <= int(status) < 300:
                        fresh["server"] = crafty_data(response) if isinstance(crafty_data(response), dict) else {}
                        with self.lock:
                            state["serverRefreshed"] = now_mono
                    else:
                        fresh["server"] = previous.get("server", {})
                else:
                    fresh["server"] = previous.get("server", {})
                fresh.update({"updatedAt": now_ts(), "stale": False, "refreshing": False, "source": "crafty-cache", "ageSeconds": 0.0})
                with self.lock:
                    state["snapshot"] = self.clone(fresh)
                    state["refreshed"] = now_mono
                return self.clone(fresh)
            if previous.get("available") and previous_age <= CRAFTY_STALE_GRACE_SECONDS:
                previous["stale"] = True
                previous["refreshing"] = False
                previous["ageSeconds"] = max(0.0, round(previous_age, 2))
                previous["refreshError"] = fresh.get("message") or f"HTTP {fresh.get('statusCode', 'unknown')}"
                return previous
            fresh.update({"updatedAt": now_ts(), "stale": False, "refreshing": False, "source": "crafty-cache", "ageSeconds": 0.0})
            with self.lock:
                state["snapshot"] = self.clone(fresh)
                state["refreshed"] = now_mono
            return self.clone(fresh)
        except Exception as exc:
            logger.warning("Crafty summary refresh failed for server=%s: %s", sid, exc)
            if previous and previous_age <= CRAFTY_STALE_GRACE_SECONDS:
                previous["stale"] = True
                previous["refreshing"] = False
                previous["ageSeconds"] = max(0.0, round(previous_age, 2))
                previous["refreshError"] = str(exc)
                return previous
            config = server_profile_config(sid)["crafty"]
            return {
                "configured": crafty_client(sid).configured(),
                "available": False,
                "panelUrl": config.get("panelUrl", ""),
                "serverId": config.get("serverId", ""),
                "stats": {}, "server": {}, "message": str(exc), "updatedAt": now_ts(),
                "stale": False, "refreshing": False, "source": "crafty-cache", "ageSeconds": 0.0,
            }
        finally:
            with self.lock:
                state["refreshing"] = False


CRAFTY_OVERVIEW_CACHE = CraftyOverviewCache()
CRAFTY_OVERVIEW = CRAFTY_OVERVIEW_CACHE


def crafty_status(server_id: Any = None) -> dict[str, Any]:
    sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    config = server_profile_config(sid)["crafty"]
    client = crafty_client(sid)
    if not client.configured():
        return {"configured": False, "available": False, "panelUrl": config.get("panelUrl", ""), "serverId": config.get("serverId", "")}
    server_id_value = str(config.get("serverId") or "")
    started = time.monotonic()
    status, response = crafty_request("GET", f"/api/v2/servers/{quote(server_id_value, safe='-')}/stats", server_id=sid)
    latency_ms = round((time.monotonic() - started) * 1000, 1)
    stats = crafty_data(response)
    message = ""
    diagnostic: dict[str, Any] = {}
    if isinstance(response, dict):
        message = str(response.get("error_data") or response.get("message") or response.get("error") or "")
        diagnostic = response.get("diagnostic") if isinstance(response.get("diagnostic"), dict) else {}
    return {
        "configured": True,
        "available": 200 <= int(status) < 300,
        "statusCode": int(status),
        "panelUrl": config.get("panelUrl", ""),
        "serverId": server_id_value,
        "target": connection_url_metadata(config.get("apiUrl", "")),
        "latencyMs": latency_ms,
        "diagnostic": diagnostic,
        "stats": stats if isinstance(stats, dict) else {},
        "message": message,
    }


def normalize_crafty_logs(payload: Any, limit: int = CRAFTY_LOG_LIMIT) -> list[str]:
    value = crafty_data(payload)
    if isinstance(value, list):
        lines = [str(line) for line in value]
    elif isinstance(value, str):
        lines = value.splitlines()
    elif isinstance(payload, dict) and isinstance(payload.get("data"), str):
        lines = str(payload["data"]).splitlines()
    else:
        lines = []
    return lines[-limit:]


def normalize_backup_configs(payload: Any) -> list[dict[str, Any]]:
    value = crafty_data(payload)
    if isinstance(value, dict):
        if isinstance(value.get("backups"), list):
            value = value["backups"]
        elif all(isinstance(item, dict) for item in value.values()):
            value = list(value.values())
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        cleaned = dict(item)
        server_value = cleaned.get("server_id")
        if isinstance(server_value, dict):
            cleaned["server_id"] = server_value.get("server_id")
        result.append(cleaned)
    return result


def crafty_server_overview(*, include_logs: bool = True, include_backups: bool = True, force: bool = False, server_id: Any = None) -> dict[str, Any]:
    sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    base = CRAFTY_OVERVIEW.get(force=force, server_id=sid)
    if not base.get("available"):
        return base
    config = server_profile_config(sid)["crafty"]
    server_path = quote(str(config.get("serverId") or ""), safe="-")
    if include_logs:
        log_status, log_response = crafty_request("GET", f"/api/v2/servers/{server_path}/logs?file=false&colors=false&raw=false&html=false", server_id=sid)
        base["logsAvailable"] = 200 <= int(log_status) < 300
        base["logs"] = normalize_crafty_logs(log_response)
    if include_backups:
        backup_status, backup_response = crafty_request("GET", f"/api/v2/servers/{server_path}/backups", server_id=sid)
        base["backupsAvailable"] = 200 <= int(backup_status) < 300
        base["backups"] = normalize_backup_configs(backup_response)
    return base


def crafty_action(action: str, server_id: Any = None) -> tuple[int, Any]:
    allowed = {"start_server", "stop_server", "restart_server", "backup_server"}
    if action not in allowed:
        return HTTPStatus.BAD_REQUEST, {"status": "error", "error": "INVALID_ACTION", "error_data": "Unsupported Crafty action"}
    sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    config = server_profile_config(sid)["crafty"]
    server_path = quote(str(config.get("serverId") or ""), safe="-")
    status, response = crafty_request("POST", f"/api/v2/servers/{server_path}/action/{action}", server_id=sid)
    if 200 <= int(status) < 300:
        CRAFTY_OVERVIEW.invalidate(sid)
    return status, response


def player_name(player: dict[str, Any]) -> str:
    return str(player.get("name") or player.get("player") or player.get("displayName") or "Player")


def player_location(player: dict[str, Any]) -> dict[str, Any]:
    location = player.get("location") if isinstance(player.get("location"), dict) else {}
    return {
        "world": location.get("world") or player.get("world"),
        "x": location.get("x", player.get("x")),
        "y": location.get("y", player.get("y")),
        "z": location.get("z", player.get("z")),
    }


class Monitor:
    def __init__(self, server_id: int) -> None:
        self.server_id = resolve_server_id(server_id)
        self.server_name = server_profile_config(self.server_id)["name"]
        self.lock = threading.RLock()
        self.players: dict[str, dict[str, Any]] = {}
        self.worlds: dict[str, dict[str, Any]] = {}
        self.server_info: dict[str, Any] = {}
        self.server_available: bool | None = None
        self.api_failure_count = 0
        self.api_failure_started_at = 0
        self.outage_alerted = False
        self.initialized = False
        self.last_metric_at = 0
        self.metric_alert_at: dict[str, int] = {}
        self.metric_condition_started_at: dict[str, int] = {}
        self.metric_active_alerts: set[str] = set()
        self.last_crafty_available: bool | None = None
        self.started_at = now_ts()
        self.last_plugin_event_id: int | None = None
        self.last_plugin_event_ts = 0
        self.last_live_player_revision = -1
        self.live_player_updated_at = 0
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name=f"player-panel-monitor-{self.server_id}", daemon=True)
        self.event_thread = threading.Thread(target=self.run_plugin_events, name=f"player-panel-plugin-events-{self.server_id}", daemon=True)

    def start(self) -> None:
        self.thread.start()
        self.event_thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=3)
        self.event_thread.join(timeout=3)

    def snapshot_players(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return {uuid: dict(player) for uuid, player in self.players.items()}

    def snapshot_server(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.server_info)

    def snapshot_live_state(self) -> dict[str, Any]:
        with self.lock:
            return {
                "revision": self.last_live_player_revision,
                "updatedAt": self.live_player_updated_at,
                "players": [dict(player) for player in self.players.values()],
            }

    def run(self) -> None:
        while not self.stop_event.is_set():
            if MAINTENANCE_MODE.is_set():
                self.stop_event.wait(1)
                continue
            try:
                self.poll()
            except Exception:
                logger.exception("Monitor poll failed")
            self.stop_event.wait(MONITOR_INTERVAL)

    def run_plugin_events(self) -> None:
        set_current_server_id(self.server_id)
        while not self.stop_event.is_set():
            if MAINTENANCE_MODE.is_set():
                self.stop_event.wait(1)
                continue
            try:
                status, body = upstream_request("GET", "/api/v1/events", quiet=True, server_id=self.server_id)
                if status == 200:
                    payload = parse_json_bytes(body)
                    self.handle_plugin_events(payload.get("events", []))
                    self.handle_live_player_state(payload.get("live"))
            except Exception:
                logger.exception("Plugin event poll failed")
            self.stop_event.wait(PLUGIN_EVENT_INTERVAL)

    def poll(self) -> None:
        # Connectivity is determined by the lightweight health endpoint.
        # Heavy snapshots can briefly time out when Minecraft enters PAUSED_EMPTY,
        # but that is to normal idle transition and must never be treated as an outage.
        timestamp = now_ts()
        status_health, body_health = upstream_request("GET", "/api/v1/health", quiet=True, server_id=self.server_id)
        health = parse_json_bytes(body_health)
        health_available = (
            status_health == 200
            and health.get("success") is True
            and health.get("serverOnline") is not False
            and health.get("ready") is not False
        )

        if status_health == HTTPStatus.TOO_MANY_REQUESTS or health.get("error") == "UPSTREAM_RATE_LIMITED":
            # A 429 proves that the adapter is reachable; it only means the
            # request budget was temporarily exhausted. Preserve the last
            # confirmed state and never emit outage/recovery alerts for it.
            self.api_failure_count = 0
            self.api_failure_started_at = 0
            self.maybe_record_metrics(self.server_available is not False, len(self.snapshot_players()))
            return

        if not health_available:
            if self.api_failure_count == 0:
                self.api_failure_started_at = timestamp
            self.api_failure_count += 1
            failure_age = max(0, timestamp - self.api_failure_started_at)
            confirmed_down = (
                self.api_failure_count >= API_DOWN_FAILURE_THRESHOLD
                and failure_age >= API_DOWN_GRACE_SECONDS
            )
            if confirmed_down:
                was_available = self.server_available is True
                self.server_available = False
                alert_delay = max(API_DOWN_GRACE_SECONDS, int(setting_float("alerts.server_down_delay_seconds", 30)))
                if (
                    setting_bool("alerts.server_down_enabled", True)
                    and failure_age >= alert_delay
                    and not self.outage_alerted
                ):
                    record_alert(
                        "server_down", "critical", "Server offline",
                        f"The panel could not communicate with Minecraft for {failure_age} seconds.",
                        dedupe_seconds=max(30, alert_delay),
                    )
                    self.outage_alerted = True
                elif was_available:
                    logger.info("Minecraft API outage confirmed; waiting %ss before alert", alert_delay)
                self.maybe_record_metrics(False, 0)
            else:
                # Keep the last confirmed state during the anti-flapping window.
                cached_online = len(self.snapshot_players())
                self.maybe_record_metrics(self.server_available is not False, cached_online)
            return

        self.api_failure_count = 0
        self.api_failure_started_at = 0
        if self.outage_alerted:
            record_alert(
                "server_up", "success", "Server restored",
                "The Minecraft server connection is available again.",
                dedupe_seconds=30,
            )
            self.outage_alerted = False
        self.server_available = True

        live_state = self.snapshot_live_state()
        live_is_fresh = (
            int(live_state.get("revision") or -1) >= 0
            and int(live_state.get("updatedAt") or 0) > 0
            and timestamp - int(live_state.get("updatedAt") or 0) <= max(3, PLUGIN_EVENT_INTERVAL * 3)
        )
        if live_is_fresh:
            status_players = HTTPStatus.OK
            body_players = json.dumps({"players": live_state.get("players", [])}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        else:
            status_players, body_players = upstream_request("GET", "/api/v1/players", quiet=True, server_id=self.server_id)
        status_server, body_server = upstream_request("GET", "/api/v1/server", quiet=True, server_id=self.server_id)

        # A healthy /health response wins over to transient snapshot failure.
        # Preserve the last good snapshot and do not emit down/up alerts.
        if status_players != 200 or status_server != 200:
            self.maybe_record_metrics(True, len(self.snapshot_players()))
            return

        players_data = parse_json_bytes(body_players)
        server_data = parse_json_bytes(body_server)
        new_players = {
            str(player.get("uuid")): player
            for player in players_data.get("players", [])
            if isinstance(player, dict) and player.get("uuid")
        }
        server = server_data.get("server", {}) if isinstance(server_data.get("server"), dict) else {}
        new_worlds = {
            str(world.get("name")): world
            for world in server.get("worlds", [])
            if isinstance(world, dict) and world.get("name")
        }

        self.maybe_record_metrics(True, len(new_players))

        with self.lock:
            old_players = self.players
            old_worlds = self.worlds

            if self.initialized:
                self.handle_player_changes(old_players, new_players)
                self.handle_world_changes(old_worlds, new_worlds)
            else:
                self.open_initial_sessions(new_players)
                self.initialized = True

            self.players = new_players
            self.worlds = new_worlds
            self.server_info = dict(server)

        # Reuse the existing five-second server snapshot to keep every browser's
        # world scene current without adding one upstream request per device.
        # Browsers interpolate the Minecraft clock between these snapshots.
        if new_worlds:
            LIVE_EVENTS.publish("worlds", {
                "updatedAt": timestamp,
                "worlds": [dict(world) for world in new_worlds.values()],
            })

    def handle_live_player_state(self, raw_state: Any) -> None:
        if not isinstance(raw_state, dict):
            return
        try:
            revision = int(raw_state.get("revision") or 0)
        except (TypeError, ValueError):
            return
        raw_players = raw_state.get("players")
        if not isinstance(raw_players, list):
            return
        updated_at = int(raw_state.get("updatedAt") or now_ts())
        new_players = {
            str(player.get("uuid")): dict(player)
            for player in raw_players
            if isinstance(player, dict) and player.get("uuid")
        }
        with self.lock:
            if revision == self.last_live_player_revision:
                return
            old_players = self.players
            joined = set(new_players) - set(old_players)
            left = set(old_players) - set(new_players)
            stayed = set(new_players) & set(old_players)
            self.players = new_players
            self.last_live_player_revision = revision
            self.live_player_updated_at = updated_at
            self.server_info = dict(self.server_info)
            self.server_info["onlinePlayers"] = len(new_players)

        if joined or left:
            self.record_live_presence_changes(old_players, new_players, joined, left)
        for uuid in stayed:
            previous_food = int(old_players[uuid].get("food") or 0)
            current_food = int(new_players[uuid].get("food") or 0)
            if current_food <= LOW_FOOD_THRESHOLD < previous_food:
                name = player_name(new_players[uuid])
                record_alert(
                    "low_food", "warning", "Low food",
                    f"{name} tiene {current_food} food points.",
                    uuid, dedupe_seconds=5,
                )

        LIVE_EVENTS.publish("players", {
            "revision": revision,
            "updatedAt": updated_at,
            "players": list(new_players.values()),
        })

    def record_live_presence_changes(
        self,
        old_players: dict[str, dict[str, Any]],
        new_players: dict[str, dict[str, Any]],
        joined: set[str],
        left: set[str],
    ) -> None:
        timestamp = now_ts()
        alerts: list[tuple[str, str, str, str, str]] = []
        with db_connect() as db:
            for uuid in joined:
                player = new_players[uuid]
                name = player_name(player)
                location = player_location(player)
                open_row = db.execute(
                    "SELECT id FROM sessions WHERE server_id=? AND player_uuid=? AND left_at IS NULL ORDER BY id DESC LIMIT 1",
                    (self.server_id, uuid),
                ).fetchone()
                if not open_row:
                    db.execute(
                        "INSERT INTO sessions(server_id, player_uuid, player_name, joined_at, last_seen, world, x, y, z, health, food) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (self.server_id, uuid, name, timestamp, timestamp, location.get("world"), location.get("x"), location.get("y"), location.get("z"), player.get("health"), player.get("food")),
                    )
                alerts.append(("join", "info", f"{name} joined", f"{name} connected to the server.", uuid))

            for uuid in left:
                player = old_players[uuid]
                name = player_name(player)
                db.execute(
                    "UPDATE sessions SET left_at=?, last_seen=? WHERE id=(SELECT id FROM sessions WHERE server_id=? AND player_uuid=? AND left_at IS NULL ORDER BY id DESC LIMIT 1)",
                    (timestamp, timestamp, self.server_id, uuid),
                )
                alerts.append(("leave", "info", f"{name} left", f"{name} disconnected from the server.", uuid))

        for alert_type, severity, title, message, uuid in alerts:
            record_alert(alert_type, severity, title, message, uuid, dedupe_seconds=12)

    def handle_plugin_events(self, raw_events: Any) -> None:
        if not isinstance(raw_events, list):
            return
        events = [item for item in raw_events if isinstance(item, dict) and int(item.get("id") or 0) > 0]
        if not events:
            return
        events.sort(key=lambda item: int(item.get("id") or 0))
        max_id = int(events[-1].get("id") or 0)
        max_ts = max(int(item.get("ts") or 0) for item in events)
        recent_floor = self.started_at - max(10, MONITOR_INTERVAL * 2)

        sequence_restarted = (
            self.last_plugin_event_id is not None
            and max_id <= self.last_plugin_event_id
            and max_ts > self.last_plugin_event_ts
        )
        if self.last_plugin_event_id is None or max_id < self.last_plugin_event_id or sequence_restarted:
            candidates = [item for item in events if int(item.get("ts") or 0) >= max(recent_floor, self.last_plugin_event_ts + 1)]
        else:
            candidates = [item for item in events if int(item.get("id") or 0) > self.last_plugin_event_id]
        self.last_plugin_event_id = max_id
        self.last_plugin_event_ts = max(self.last_plugin_event_ts, max_ts)

        for event in candidates:
            event_type = str(event.get("type") or "")
            name = str(event.get("player") or "Unknown player")
            uuid = str(event.get("uuid") or "") or None

            if event_type == "join":
                record_alert(
                    "join", "info", f"{name} joined", f"{name} connected to the server.",
                    uuid, dedupe_seconds=12,
                )
                continue

            if event_type == "leave":
                record_alert(
                    "leave", "info", f"{name} left", f"{name} disconnected from the server.",
                    uuid, dedupe_seconds=12,
                )
                continue

            if event_type == "whitelist_denied":
                ip = str(event.get("ip") or "") or None
                record_alert(
                    "whitelist_denied",
                    "warning",
                    "Non-whitelisted connection attempt",
                    f"{name} attempted to connect without authorization. IP: {ip or 'unknown'}. UUID: {uuid or 'unknown'}.",
                    uuid,
                    dedupe_seconds=10,
                )
                record_audit(
                    "whitelist",
                    "connection_denied",
                    "blocked",
                    actor="server",
                    player_uuid=uuid,
                    player_name=name,
                    details={"ip": ip, "uuid": uuid, "result": event.get("result")},
                )
                continue

            if event_type == "death":
                world = str(event.get("world") or "world")
                x = event.get("x", "?")
                y = event.get("y", "?")
                z = event.get("z", "?")
                death_message = str(event.get("message") or "").strip()
                cause = death_message if death_message else f"{name} died"
                message = f"{cause}. Location: {world} {x}, {y}, {z}."
                record_alert("death", "warning", f"{name} died", message, uuid, dedupe_seconds=10)
                record_audit(
                    "players",
                    "death",
                    "recorded",
                    actor="server",
                    player_uuid=uuid,
                    player_name=name,
                    details={"message": death_message, "world": world, "x": x, "y": y, "z": z},
                )

    def maybe_record_metrics(self, api_available: bool, online_players: int) -> None:
        timestamp = now_ts()
        if timestamp - self.last_metric_at < METRICS_SAMPLE_INTERVAL:
            return
        self.last_metric_at = timestamp

        metrics_available, plugin_metrics = plugin_metrics_snapshot()
        runtime_state = str(plugin_metrics.get("state") or "UNKNOWN").upper() if metrics_available else "UNAVAILABLE"
        plugin_tps = plugin_metrics.get("tps") if isinstance(plugin_metrics.get("tps"), dict) else {}
        tps_current = numeric_metric(plugin_tps.get("current") or plugin_metrics.get("tpsCurrent"))
        plugin_cpu = plugin_metrics.get("cpu") if isinstance(plugin_metrics.get("cpu"), dict) else {}
        plugin_memory = plugin_metrics.get("memory") if isinstance(plugin_metrics.get("memory"), dict) else {}
        plugin_players = plugin_metrics.get("players") if isinstance(plugin_metrics.get("players"), dict) else {}

        crafty = crafty_status()
        crafty_available = bool(crafty.get("available"))
        stats = crafty.get("stats") if isinstance(crafty.get("stats"), dict) else {}
        cpu = numeric_metric(backend_find_metric(stats, ("cpu", "cpu_usage", "cpu_percent")))
        if cpu is None:
            cpu = numeric_metric(plugin_cpu.get("processPercent"))
        if cpu is None:
            cpu = numeric_metric(plugin_cpu.get("systemPercent"))

        memory = numeric_metric(backend_find_metric(stats, ("mem", "memory", "memory_usage", "memory_used", "mem_usage")))
        memory_percent = numeric_metric(backend_find_metric(stats, ("mem_percent", "memory_percent")))
        if memory is None:
            memory = numeric_metric(plugin_memory.get("usedBytes") or plugin_metrics.get("memoryUsedBytes"))
        if memory_percent is None:
            memory_percent = numeric_metric(plugin_memory.get("usagePercent"))

        max_players = numeric_metric(backend_find_metric(stats, ("max", "max_players")))
        if max_players is None:
            max_players = numeric_metric(plugin_players.get("maximum"))
        running = crafty_running(stats) if crafty_available else bool(api_available)
        uptime = crafty_uptime_seconds(stats) if crafty_available else None
        if uptime is None:
            raw_uptime = numeric_metric(plugin_metrics.get("uptimeSeconds"))
            uptime = int(raw_uptime) if raw_uptime is not None else None

        disk = shutil.disk_usage(DATA_ROOT)
        storage_percent = round((disk.used / disk.total * 100) if disk.total else 0.0, 2)
        with db_connect() as db:
            db.execute(
                "INSERT INTO metrics(server_id, ts, api_available, crafty_available, server_running, online_players, max_players, cpu_percent, memory_bytes, memory_percent, uptime_seconds, tps_current, storage_percent, storage_free_bytes, runtime_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    self.server_id, timestamp, int(api_available), int(crafty_available), int(running), int(online_players),
                    int(max_players) if max_players is not None else None, cpu,
                    int(memory) if memory is not None else None, memory_percent, uptime,
                    tps_current, storage_percent, int(disk.free), runtime_state,
                ),
            )
            db.execute("DELETE FROM metrics WHERE server_id=? AND ts < ?", (self.server_id, timestamp - int(setting_float("metrics.retention_days", METRICS_RETENTION_DAYS)) * 86400))
        self.check_metric_alerts(
            timestamp,
            crafty_available=crafty_available,
            cpu=cpu,
            memory_percent=memory_percent,
            tps=tps_current,
            storage_percent=storage_percent,
            storage_free_bytes=int(disk.free),
            runtime_state=runtime_state,
            online_players=online_players,
        )

    def check_metric_alerts(
        self,
        timestamp: int,
        *,
        crafty_available: bool,
        cpu: float | None,
        memory_percent: float | None,
        tps: float | None,
        storage_percent: float | None,
        storage_free_bytes: int | None,
        runtime_state: str,
        online_players: int,
    ) -> None:
        cooldown = max(60, int(setting_float("metrics.alert_cooldown_seconds", 900)))
        recovery_alerts = setting_bool("metrics.recovery_alerts_enabled", True)
        if self.last_crafty_available is True and not crafty_available:
            record_alert("crafty_down", "critical", "Crafty offline", "The panel cannot query Crafty metrics.")
        elif self.last_crafty_available is False and crafty_available:
            record_alert("crafty_up", "success", "Crafty restored", "The Crafty connection is available again.")
        self.last_crafty_available = crafty_available

        rules = [
            {
                "key": "high_cpu", "enabled": setting_bool("metrics.high_cpu_enabled", True),
                "value": cpu, "limit": setting_float("metrics.high_cpu_threshold", 85),
                "duration": int(setting_float("metrics.high_cpu_duration_seconds", 120)),
                "triggered": lambda value, limit: value >= limit,
                "title": "CPU alta",
                "message": lambda value, limit: f"CPU reached {value:.1f}% for the configured duration (limit {limit:.0f}%).",
                "recovery": "CPU returned to normal values.",
            },
            {
                "key": "high_memory", "enabled": setting_bool("metrics.high_memory_enabled", True),
                "value": memory_percent, "limit": setting_float("metrics.high_memory_threshold", 90),
                "duration": int(setting_float("metrics.high_memory_duration_seconds", 120)),
                "triggered": lambda value, limit: value >= limit,
                "title": "Memoria alta",
                "message": lambda value, limit: f"Memory reached {value:.1f}% for the configured duration (limit {limit:.0f}%).",
                "recovery": "Memory usage returned to normal.",
            },
            {
                "key": "low_tps", "enabled": setting_bool("metrics.low_tps_enabled", True),
                "value": tps, "limit": setting_float("metrics.low_tps_threshold", 17),
                "duration": int(setting_float("metrics.low_tps_duration_seconds", 60)),
                "triggered": lambda value, limit: value < limit,
                "title": "TPS bajo",
                "message": lambda value, limit: f"The server remained at {value:.2f} TPS (minimum limit {limit:.1f}).",
                "recovery": "TPS returned to normal values.",
                "eligible": runtime_state == "RUNNING" and online_players > 0,
            },
            {
                "key": "high_storage", "enabled": setting_bool("metrics.high_storage_enabled", True),
                "value": storage_percent, "limit": setting_float("metrics.high_storage_threshold", 90),
                "duration": int(setting_float("metrics.high_storage_duration_seconds", 300)),
                "triggered": lambda value, limit: value >= limit,
                "title": "Almacenamiento alto",
                "message": lambda value, limit: f"Storage usage is {value:.1f}% (limit {limit:.0f}%). Free space: {human_bytes(storage_free_bytes)}.",
                "recovery": "Storage returned below the configured limit.",
            },
        ]

        for rule in rules:
            key = str(rule["key"])
            value = rule.get("value")
            enabled = bool(rule.get("enabled"))
            eligible = bool(rule.get("eligible", True))
            limit = float(rule["limit"])
            duration = min(max(0, int(rule["duration"])), 86400)
            if not enabled:
                self.metric_condition_started_at.pop(key, None)
                self.metric_active_alerts.discard(key)
                continue
            if not eligible:
                self.metric_condition_started_at.pop(key, None)
                self.metric_active_alerts.discard(key)
                continue
            if value is None:
                # Missing telemetry is not proof that the condition recovered.
                continue
            condition = bool(rule["triggered"](float(value), limit))
            if not condition:
                self.metric_condition_started_at.pop(key, None)
                if key in self.metric_active_alerts:
                    self.metric_active_alerts.discard(key)
                    if recovery_alerts:
                        record_alert(
                            "metrics_recovered", "success", f"{rule['title']} resuelto",
                            str(rule["recovery"]), dedupe_seconds=60,
                        )
                continue

            started_at = self.metric_condition_started_at.setdefault(key, timestamp)
            if timestamp - started_at < duration:
                continue
            last_alert = self.metric_alert_at.get(key, 0)
            if key in self.metric_active_alerts and timestamp - last_alert < cooldown:
                continue
            if key not in self.metric_active_alerts or timestamp - last_alert >= cooldown:
                severity = "critical" if key == "high_storage" and float(value) >= 95 else "warning"
                record_alert(
                    key, severity, str(rule["title"]),
                    rule["message"](float(value), limit),
                    dedupe_seconds=max(60, min(cooldown, 3600)),
                )
                self.metric_active_alerts.add(key)
                self.metric_alert_at[key] = timestamp

    def open_initial_sessions(self, players: dict[str, dict[str, Any]]) -> None:
        timestamp = now_ts()
        with db_connect() as db:
            open_rows = db.execute("SELECT id, player_uuid FROM sessions WHERE server_id=? AND left_at IS NULL", (self.server_id,)).fetchall()
            for row in open_rows:
                if row["player_uuid"] not in players:
                    db.execute("UPDATE sessions SET left_at=?, last_seen=? WHERE id=?", (timestamp, timestamp, row["id"]))
            for uuid, player in players.items():
                open_row = db.execute(
                    "SELECT id FROM sessions WHERE server_id=? AND player_uuid=? AND left_at IS NULL ORDER BY id DESC LIMIT 1",
                    (self.server_id, uuid),
                ).fetchone()
                location = player_location(player)
                if open_row:
                    db.execute(
                        "UPDATE sessions SET last_seen=?, player_name=?, world=?, x=?, y=?, z=?, health=?, food=? WHERE id=?",
                        (timestamp, player_name(player), location.get("world"), location.get("x"), location.get("y"), location.get("z"), player.get("health"), player.get("food"), open_row["id"]),
                    )
                else:
                    db.execute(
                        "INSERT INTO sessions(server_id, player_uuid, player_name, joined_at, last_seen, world, x, y, z, health, food) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (self.server_id, uuid, player_name(player), timestamp, timestamp, location.get("world"), location.get("x"), location.get("y"), location.get("z"), player.get("health"), player.get("food")),
                    )

    def handle_player_changes(self, old: dict[str, dict[str, Any]], new: dict[str, dict[str, Any]]) -> None:
        timestamp = now_ts()
        joined = set(new) - set(old)
        left = set(old) - set(new)
        stayed = set(new) & set(old)
        pending_alerts: list[tuple[str, str, str, str, str | None]] = []

        with db_connect() as db:
            for uuid in joined:
                player = new[uuid]
                location = player_location(player)
                name = player_name(player)
                db.execute(
                    "INSERT INTO sessions(server_id, player_uuid, player_name, joined_at, last_seen, world, x, y, z, health, food) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (self.server_id, uuid, name, timestamp, timestamp, location.get("world"), location.get("x"), location.get("y"), location.get("z"), player.get("health"), player.get("food")),
                )
                pending_alerts.append(("join", "info", f"{name} joined", f"{name} connected to the server.", uuid))

            for uuid in left:
                player = old[uuid]
                name = player_name(player)
                db.execute(
                    "UPDATE sessions SET left_at=?, last_seen=? WHERE id=(SELECT id FROM sessions WHERE server_id=? AND player_uuid=? AND left_at IS NULL ORDER BY id DESC LIMIT 1)",
                    (timestamp, timestamp, self.server_id, uuid),
                )
                pending_alerts.append(("leave", "info", f"{name} left", f"{name} disconnected from the server.", uuid))

            for uuid in stayed:
                current = new[uuid]
                previous = old[uuid]
                location = player_location(current)
                db.execute(
                    "UPDATE sessions SET last_seen=?, player_name=?, world=?, x=?, y=?, z=?, health=?, food=? WHERE id=(SELECT id FROM sessions WHERE server_id=? AND player_uuid=? AND left_at IS NULL ORDER BY id DESC LIMIT 1)",
                    (timestamp, player_name(current), location.get("world"), location.get("x"), location.get("y"), location.get("z"), current.get("health"), current.get("food"), self.server_id, uuid),
                )

                old_food = int(previous.get("food") or 0)
                new_food = int(current.get("food") or 0)
                if new_food <= LOW_FOOD_THRESHOLD < old_food:
                    pending_alerts.append(("low_food", "warning", "Low food", f"{player_name(current)} tiene {new_food} food points.", uuid))

        for alert_type, severity, title, message, player_uuid in pending_alerts:
            dedupe = 12 if alert_type in {"join", "leave"} else 5
            record_alert(alert_type, severity, title, message, player_uuid, dedupe_seconds=dedupe)

    def handle_world_changes(self, old: dict[str, dict[str, Any]], new: dict[str, dict[str, Any]]) -> None:
        for name in set(old) & set(new):
            old_weather = str(old[name].get("weather") or "")
            new_weather = str(new[name].get("weather") or "")
            if old_weather and new_weather and old_weather != new_weather:
                record_alert("weather", "info", f"Weather in {name}", f"Weather changed from {old_weather} to {new_weather}.")


MONITORS_LOCK = threading.RLock()
MONITORS: dict[int, Monitor] = {}


def get_monitor(server_id: Any = None, *, start: bool = True) -> Monitor:
    sid = resolve_server_id(server_id if server_id is not None else getattr(REQUEST_CONTEXT, "server_id", 0))
    with MONITORS_LOCK:
        monitor = MONITORS.get(sid)
        if monitor is None:
            monitor = Monitor(sid)
            MONITORS[sid] = monitor
            if start:
                monitor.start()
        return monitor


def stop_server_monitor(server_id: Any) -> None:
    sid = resolve_server_id(server_id, active_only=False)
    with MONITORS_LOCK:
        monitor = MONITORS.pop(sid, None)
    if monitor is not None:
        monitor.stop()


def stop_all_monitors() -> None:
    with MONITORS_LOCK:
        monitors = list(MONITORS.values())
        MONITORS.clear()
    for monitor in monitors:
        monitor.stop()


# Compatibility alias for code paths that are resolved after the request context
# has selected to server. New code should call get_monitor().
class MonitorProxy:
    def __getattr__(self, name: str) -> Any:
        return getattr(get_monitor(), name)


MONITOR = MonitorProxy()


def push_subscriptions_for_user(user_id: int) -> list[dict[str, Any]]:
    with db_connect() as db:
        rows = db.execute(
            "SELECT id, endpoint, device_name, event_types_json, enabled, created_at, updated_at, last_success, last_error, vapid_key_id, repair_required FROM push_subscriptions WHERE user_id=? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    result = []
    for row in rows:
        item = row_dict(row)
        try:
            item["eventTypes"] = normalize_push_events(json.loads(item.pop("event_types_json") or "[]"))
        except json.JSONDecodeError:
            item["eventTypes"] = sorted(PUSH_DEFAULT_EVENTS)
        item["enabled"] = bool(item["enabled"])
        item["repairRequired"] = bool(item.pop("repair_required", 0))
        item["vapidKeyId"] = str(item.pop("vapid_key_id", "") or "")
        result.append(item)
    return result


def cached_remote_png(cache_group: str, cache_name: str, urls: list[str]) -> bytes | None:
    safe_name = hashlib.sha256(cache_name.encode("utf-8")).hexdigest()
    cache_dir = MEDIA_CACHE_ROOT / cache_group
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / f"{safe_name}.png"
    try:
        if target.is_file() and time.time() - target.stat().st_mtime < MEDIA_CACHE_TTL:
            data = target.read_bytes()
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                return data
    except OSError:
        pass
    for url in urls:
        request = urllib.request.Request(url, headers={"User-Agent": f"PlayerPanelWeb/{APP_VERSION}"})
        try:
            with urllib.request.urlopen(request, timeout=MEDIA_TIMEOUT) as response:
                content_type = response.headers.get("Content-Type", "").lower()
                data = response.read(2_000_001)
            if len(data) > 2_000_000 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
                continue
            if content_type and "image" not in content_type and "octet-stream" not in content_type:
                continue
            try:
                target.write_bytes(data)
            except OSError:
                pass
            return data
        except urllib.error.HTTPError as exc:
            logger.warning("Media download failed: HTTP %s for %s", exc.code, url)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.warning("Media download failed for %s: %s", url, exc)
    return None


def fallback_svg(label: str, player: bool = False) -> bytes:
    clean = re.sub(r"[^A-Za-z0-9]", "", label)[:2].upper() or "?"
    if player:
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
               '<rect width="64" height="64" rx="10" fill="#252b37"/>'
               '<rect x="12" y="10" width="40" height="40" rx="6" fill="#5d78d8"/>'
               '<rect x="18" y="20" width="8" height="8" fill="#fff"/>'
               '<rect x="38" y="20" width="8" height="8" fill="#fff"/>'
               '<rect x="27" y="35" width="10" height="5" fill="#25304f"/>'
               f'<text x="32" y="61" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#dbe6ff">{xml_escape(clean)}</text></svg>')
    else:
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
               '<rect width="64" height="64" rx="8" fill="#161a21"/>'
               '<path d="M32 7 54 19v26L32 57 10 45V19z" fill="#4c6380"/>'
               '<path d="M32 7v25m22-13L32 32 10 19m22 13v25" fill="none" stroke="#9fb7d5" stroke-width="2"/>'
               f'<text x="32" y="37" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="#fff">{xml_escape(clean)}</text></svg>')
    return svg.encode("utf-8")


def query_places() -> list[dict[str, Any]]:
    server_id = current_server_id()
    with db_connect() as db:
        return [row_dict(row) for row in db.execute("SELECT * FROM places WHERE server_id=? ORDER BY name COLLATE NOCASE", (server_id,))]


def query_alerts(since: int = 0, limit: int = 50) -> list[dict[str, Any]]:
    limit = min(max(limit, 1), 200)
    with db_connect() as db:
        rows = db.execute(
            "SELECT * FROM alerts WHERE server_id=? AND id>? ORDER BY id DESC LIMIT ?",
            (current_server_id(), since, limit),
        ).fetchall()
    return [row_dict(row) for row in rows]


def query_audit(limit: int = 100, offset: int = 0, category: str = "") -> list[dict[str, Any]]:
    limit = min(max(limit, 1), 250)
    offset = max(offset, 0)
    with db_connect() as db:
        if category:
            rows = db.execute(
                "SELECT * FROM audit WHERE server_id=? AND category=? ORDER BY id DESC LIMIT ? OFFSET ?",
                (current_server_id(), category, limit, offset),
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM audit WHERE server_id=? ORDER BY id DESC LIMIT ? OFFSET ?", (current_server_id(), limit, offset)).fetchall()
    result = []
    for row in rows:
        item = row_dict(row)
        try:
            item["details"] = json.loads(item.get("details") or "{}")
        except json.JSONDecodeError:
            pass
        result.append(item)
    return result


def query_sessions(limit: int = 100) -> list[dict[str, Any]]:
    limit = min(max(limit, 1), 250)
    with db_connect() as db:
        rows = db.execute("SELECT * FROM sessions WHERE server_id=? ORDER BY joined_at DESC LIMIT ?", (current_server_id(), limit)).fetchall()
    return [row_dict(row) for row in rows]


def plugin_health_snapshot() -> tuple[bool, dict[str, Any]]:
    status, body = upstream_request("GET", "/api/v1/health", quiet=True)
    payload = parse_json_bytes(body)
    available = (
        status == 200
        and payload.get("success") is True
        and payload.get("serverOnline") is not False
        and payload.get("ready") is not False
    )
    return available, payload if isinstance(payload, dict) else {}


def plugin_metrics_snapshot() -> tuple[bool, dict[str, Any]]:
    status, body = upstream_request("GET", "/api/v1/metrics", quiet=True)
    payload = parse_json_bytes(body)
    metrics = payload.get("metrics", {}) if status == 200 else {}
    return status == 200 and isinstance(metrics, dict), metrics if isinstance(metrics, dict) else {}


def paused_empty_proxy_fallback(path: str) -> tuple[int, bytes] | None:
    if path not in {"/api/v1/server", "/api/v1/players"}:
        return None
    health_available, health = plugin_health_snapshot()
    metrics_available, metrics = plugin_metrics_snapshot()
    if not health_available or not metrics_available or str(metrics.get("state") or "").upper() != "PAUSED_EMPTY":
        return None

    if path == "/api/v1/players":
        payload: dict[str, Any] = {
            "success": True,
            "players": [],
            "snapshotFallback": True,
            "metricsState": "PAUSED_EMPTY",
        }
    else:
        server = MONITOR.snapshot_server()
        if not server:
            server = {
                "software": "Fabric",
                "platform": str(health.get("platform") or "FABRIC"),
                "serverVersion": str(health.get("version") or "Fabric"),
                "minecraftVersion": "26.1.2",
                "maximumPlayers": 20,
                "worlds": [],
            }
        server["onlinePlayers"] = 0
        server["metrics"] = metrics
        payload = {
            "success": True,
            "server": server,
            "snapshotFallback": True,
            "metricsState": "PAUSED_EMPTY",
        }
    return HTTPStatus.OK, json.dumps(payload, ensure_ascii=False).encode("utf-8")


def dashboard_payload() -> dict[str, Any]:
    health_available, _health = plugin_health_snapshot()
    status_server, body_server = upstream_request("GET", "/api/v1/server", quiet=True)
    status_players, body_players = upstream_request("GET", "/api/v1/players", quiet=True)
    metrics_available, plugin_metrics = plugin_metrics_snapshot()
    crafty_snapshot = CRAFTY_OVERVIEW.get()
    crafty_stats = crafty_snapshot.get("stats") if isinstance(crafty_snapshot.get("stats"), dict) else {}
    server_data = parse_json_bytes(body_server)
    players_data = parse_json_bytes(body_players)
    snapshots_available = status_server == 200 and status_players == 200
    if snapshots_available:
        server = server_data.get("server", {}) if isinstance(server_data.get("server"), dict) else {}
        players = players_data.get("players", []) if isinstance(players_data.get("players"), list) else []
    elif health_available:
        server = MONITOR.snapshot_server()
        players = list(MONITOR.snapshot_players().values())
    else:
        server = {}
        players = []
    live_state = MONITOR.snapshot_live_state()
    live_revision = int(live_state.get("revision") or -1)
    live_updated_at = int(live_state.get("updatedAt") or 0)
    if live_revision >= 0 and live_updated_at > 0 and now_ts() - live_updated_at <= 10:
        players = live_state.get("players", []) if isinstance(live_state.get("players"), list) else players
        if isinstance(server, dict):
            server = dict(server)
            server["onlinePlayers"] = len(players)
    players = [player for player in players if isinstance(player, dict)]
    if not metrics_available and isinstance(server.get("metrics"), dict):
        plugin_metrics = dict(server.get("metrics") or {})
        metrics_available = bool(plugin_metrics)
    cutoff = now_ts() - 86400
    with db_connect() as db:
        server_id = current_server_id()
        session_count = db.execute("SELECT COUNT(*) FROM sessions WHERE server_id=? AND joined_at>=?", (server_id, cutoff)).fetchone()[0]
        action_count = db.execute("SELECT COUNT(*) FROM audit WHERE server_id=? AND ts>=?", (server_id, cutoff)).fetchone()[0]
        unread_count = db.execute("SELECT COUNT(*) FROM alerts WHERE server_id=? AND is_read=0", (server_id,)).fetchone()[0]
        deaths_count = db.execute("SELECT COUNT(*) FROM alerts WHERE server_id=? AND type='death' AND ts>=?", (server_id, cutoff)).fetchone()[0]
        latest_metric = db.execute(
            "SELECT ts, cpu_percent, memory_bytes, memory_percent, uptime_seconds, tps_current, runtime_state "
            "FROM metrics WHERE server_id=? ORDER BY ts DESC LIMIT 1", (server_id,)
        ).fetchone()
    latest = row_dict(latest_metric) if latest_metric else {}
    plugin_cpu = plugin_metrics.get("cpu") if isinstance(plugin_metrics.get("cpu"), dict) else {}
    plugin_memory = plugin_metrics.get("memory") if isinstance(plugin_metrics.get("memory"), dict) else {}
    plugin_tps = plugin_metrics.get("tps") if isinstance(plugin_metrics.get("tps"), dict) else {}

    def first_numeric(*values: Any) -> float | None:
        for value in values:
            parsed = numeric_metric(value)
            if parsed is not None:
                return parsed
        return None

    telemetry_ts = int(latest.get("ts") or 0)
    crafty_memory_bytes = first_numeric(backend_find_metric(crafty_stats, ("mem", "memory", "memory_usage", "memory_used", "mem_usage")))
    crafty_memory_percent = first_numeric(backend_find_metric(crafty_stats, ("mem_percent", "memory_percent")))
    crafty_updated_at = int(crafty_snapshot.get("updatedAt") or 0)
    telemetry = {
        "cpuPercent": first_numeric(plugin_cpu.get("processPercent"), plugin_cpu.get("systemPercent"), latest.get("cpu_percent")),
        # RAM in Resumen intentionally uses the same Crafty stats snapshot as
        # Server > Management & Status.
        "memoryBytes": first_numeric(crafty_memory_bytes, plugin_memory.get("usedBytes"), plugin_metrics.get("memoryUsedBytes"), latest.get("memory_bytes")),
        "memoryPercent": first_numeric(crafty_memory_percent, plugin_memory.get("usagePercent"), latest.get("memory_percent")),
        "memorySource": "crafty" if crafty_memory_bytes is not None or crafty_memory_percent is not None else "fallback",
        "craftyUpdatedAt": crafty_updated_at or None,
        "craftyStale": bool(crafty_snapshot.get("stale")),
        "tps": first_numeric(plugin_tps.get("current"), plugin_metrics.get("tpsCurrent"), latest.get("tps_current")),
        "uptimeSeconds": first_numeric(plugin_metrics.get("uptimeSeconds"), latest.get("uptime_seconds")),
        "runtimeState": str(plugin_metrics.get("state") or latest.get("runtime_state") or "UNKNOWN").upper(),
        "updatedAt": telemetry_ts or crafty_updated_at or None,
        "stale": bool(telemetry_ts and now_ts() - telemetry_ts > max(180, METRICS_SAMPLE_INTERVAL * 3)),
    }
    worlds = server.get("worlds", []) if isinstance(server, dict) else []
    return {
        "success": True,
        "apiAvailable": health_available,
        "dataStale": bool(health_available and not snapshots_available),
        "metricsAvailable": metrics_available,
        "pluginMetrics": plugin_metrics,
        "telemetry": telemetry,
        "server": server,
        "players": players,
        "livePlayers": {"revision": live_revision, "updatedAt": live_updated_at},
        "summary": {
            "online": len(players),
            "lowFood": sum(1 for player in players if int(player.get("food") or 0) <= LOW_FOOD_THRESHOLD),
            "worlds": len(worlds),
            "sessions24h": int(session_count),
            "actions24h": int(action_count),
            "deaths24h": int(deaths_count),
            "unreadAlerts": int(unread_count),
        },
        "alerts": query_alerts(limit=8),
        "sessions": query_sessions(limit=8),
        "places": query_places(),
    }


def query_metrics(hours: int = 24, bucket_seconds: int = 300) -> dict[str, Any]:
    metrics_available, runtime_metrics = plugin_metrics_snapshot()
    hours = min(max(int(hours), 1), METRICS_RETENTION_DAYS * 24)
    bucket_seconds = min(max(int(bucket_seconds), 60), 86400)
    cutoff = now_ts() - hours * 3600
    with db_connect() as db:
        rows = db.execute(
            "SELECT (ts / ?) * ? AS bucket_ts, AVG(cpu_percent) AS cpu_percent, AVG(memory_bytes) AS memory_bytes, AVG(memory_percent) AS memory_percent, AVG(online_players) AS online_players, MAX(online_players) AS peak_players, MAX(max_players) AS max_players, MAX(api_available) AS api_available, MAX(crafty_available) AS crafty_available, MAX(server_running) AS server_running, AVG(tps_current) AS tps_current, AVG(storage_percent) AS storage_percent, MIN(storage_free_bytes) AS storage_free_bytes FROM metrics WHERE server_id=? AND ts>=? GROUP BY bucket_ts ORDER BY bucket_ts",
            (bucket_seconds, bucket_seconds, current_server_id(), cutoff),
        ).fetchall()
        summary = db.execute(
            "SELECT COUNT(*) AS samples, AVG(cpu_percent) AS avg_cpu, MAX(cpu_percent) AS max_cpu, AVG(memory_bytes) AS avg_memory_bytes, MAX(memory_bytes) AS max_memory_bytes, AVG(memory_percent) AS avg_memory_percent, MAX(memory_percent) AS max_memory_percent, AVG(online_players) AS avg_players, MAX(online_players) AS peak_players, AVG(tps_current) AS avg_tps, MIN(tps_current) AS min_tps, AVG(storage_percent) AS avg_storage_percent, MAX(storage_percent) AS max_storage_percent, MIN(storage_free_bytes) AS min_storage_free_bytes, SUM(CASE WHEN server_running=1 THEN 1 ELSE 0 END) AS running_samples, SUM(CASE WHEN api_available=1 THEN 1 ELSE 0 END) AS api_samples FROM metrics WHERE server_id=? AND ts>=?",
            (current_server_id(), cutoff),
        ).fetchone()
    points = [row_dict(row) for row in rows]
    summary_dict = row_dict(summary) if summary else {}
    samples = int(summary_dict.get("samples") or 0)
    summary_dict["serverAvailabilityPercent"] = round(100 * int(summary_dict.get("running_samples") or 0) / samples, 2) if samples else None
    summary_dict["apiAvailabilityPercent"] = round(100 * int(summary_dict.get("api_samples") or 0) / samples, 2) if samples else None
    return {
        "success": True,
        "hours": hours,
        "bucketSeconds": bucket_seconds,
        "retentionDays": METRICS_RETENTION_DAYS,
        "runtimeAvailable": metrics_available,
        "runtime": runtime_metrics,
        "points": points,
        "summary": summary_dict,
        "settings": {
            "highCpuEnabled": setting_bool("metrics.high_cpu_enabled", True),
            "highCpuThreshold": setting_float("metrics.high_cpu_threshold", 85),
            "highCpuDurationSeconds": int(setting_float("metrics.high_cpu_duration_seconds", 120)),
            "highMemoryEnabled": setting_bool("metrics.high_memory_enabled", True),
            "highMemoryThreshold": setting_float("metrics.high_memory_threshold", 90),
            "highMemoryDurationSeconds": int(setting_float("metrics.high_memory_duration_seconds", 120)),
            "lowTpsEnabled": setting_bool("metrics.low_tps_enabled", True),
            "lowTpsThreshold": setting_float("metrics.low_tps_threshold", 17),
            "lowTpsDurationSeconds": int(setting_float("metrics.low_tps_duration_seconds", 60)),
            "highStorageEnabled": setting_bool("metrics.high_storage_enabled", True),
            "highStorageThreshold": setting_float("metrics.high_storage_threshold", 90),
            "highStorageDurationSeconds": int(setting_float("metrics.high_storage_duration_seconds", 300)),
            "serverDownEnabled": setting_bool("alerts.server_down_enabled", True),
            "serverDownDelaySeconds": int(setting_float("alerts.server_down_delay_seconds", 30)),
            "recoveryAlertsEnabled": setting_bool("metrics.recovery_alerts_enabled", True),
            "alertCooldownSeconds": int(setting_float("metrics.alert_cooldown_seconds", 900)),
        },
    }


def update_metric_settings(data: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {
        "metrics.high_cpu_enabled": bool(data.get("highCpuEnabled", True)),
        "metrics.high_cpu_threshold": float(data.get("highCpuThreshold", 85)),
        "metrics.high_cpu_duration_seconds": int(data.get("highCpuDurationSeconds", 120)),
        "metrics.high_memory_enabled": bool(data.get("highMemoryEnabled", True)),
        "metrics.high_memory_threshold": float(data.get("highMemoryThreshold", 90)),
        "metrics.high_memory_duration_seconds": int(data.get("highMemoryDurationSeconds", 120)),
        "metrics.low_tps_enabled": bool(data.get("lowTpsEnabled", True)),
        "metrics.low_tps_threshold": float(data.get("lowTpsThreshold", 17)),
        "metrics.low_tps_duration_seconds": int(data.get("lowTpsDurationSeconds", 60)),
        "metrics.high_storage_enabled": bool(data.get("highStorageEnabled", True)),
        "metrics.high_storage_threshold": float(data.get("highStorageThreshold", 90)),
        "metrics.high_storage_duration_seconds": int(data.get("highStorageDurationSeconds", 300)),
        "alerts.server_down_enabled": bool(data.get("serverDownEnabled", True)),
        "alerts.server_down_delay_seconds": int(data.get("serverDownDelaySeconds", 30)),
        "metrics.recovery_alerts_enabled": bool(data.get("recoveryAlertsEnabled", True)),
        "metrics.alert_cooldown_seconds": int(data.get("alertCooldownSeconds", 900)),
    }
    if not 10 <= values["metrics.high_cpu_threshold"] <= 100:
        raise ValueError("The CPU threshold must be between 10 and 100")
    if not 10 <= values["metrics.high_memory_threshold"] <= 100:
        raise ValueError("The memory threshold must be between 10 and 100")
    if not 5 <= values["metrics.low_tps_threshold"] <= 20:
        raise ValueError("The TPS threshold must be between 5 and 20")
    if not 50 <= values["metrics.high_storage_threshold"] <= 99:
        raise ValueError("The storage threshold must be between 50 and 99")
    for key in (
        "metrics.high_cpu_duration_seconds", "metrics.high_memory_duration_seconds",
        "metrics.low_tps_duration_seconds", "metrics.high_storage_duration_seconds",
    ):
        if not 0 <= int(values[key]) <= 86400:
            raise ValueError("A rule duration must be between 0 and 86400 seconds")
    if not 10 <= values["alerts.server_down_delay_seconds"] <= 3600:
        raise ValueError("The outage delay must be between 10 and 3600 seconds")
    if not 60 <= values["metrics.alert_cooldown_seconds"] <= 86400:
        raise ValueError("The interval must be between 60 and 86400 seconds")
    with db_connect() as db:
        for key, value in values.items():
            stored = "1" if value is True else "0" if value is False else str(value)
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, stored, now_ts()),
            )
    return query_metrics(24, 300)["settings"]



def human_bytes(value: int | float | None) -> str:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        number = 0
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    index = 0
    while abs(number) >= 1024 and index < len(units) - 1:
        number /= 1024
        index += 1
    return f"{number:.0f} {units[index]}" if index == 0 else f"{number:.2f} {units[index]}"


def safe_backup_name(name: str) -> str:
    value = Path(str(name or "")).name
    if not re.fullmatch(r"player-panel-backup-\d{8}-\d{6}(?:-[a-z0-9-]{1,24})?\.tar\.gz", value):
        raise ValueError("Invalid backup name")
    return value


def database_snapshot(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH, timeout=30) as source, sqlite3.connect(target, timeout=30) as destination:
        source.execute("PRAGMA wal_checkpoint(PASSIVE)")
        source.backup(destination)
        check = destination.execute("PRAGMA integrity_check").fetchone()
        if not check or str(check[0]).lower() != "ok":
            raise RuntimeError("The SQLite backup failed integrity verification")


def secret_backup_values() -> dict[str, str]:
    return {
        "player_panel_api_token.txt": API_TOKEN,
        "admin_password.txt": ADMIN_PASSWORD,
        "session_secret.txt": SESSION_SECRET,
        "crafty_username.txt": CRAFTY_USERNAME,
        "crafty_password.txt": CRAFTY_PASSWORD,
        "crafty_api_token.txt": CRAFTY_API_TOKEN,
    }


def backup_retention() -> int:
    return min(max(int(setting_float("system.backup_retention", 10)), 1), 50)


def list_system_backups() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for path in sorted(BACKUP_ROOT.glob("player-panel-backup-*.tar.gz"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            stat = path.stat()
            metadata: dict[str, Any] = {}
            with tarfile.open(path, "r:gz") as archive:
                try:
                    member = archive.getmember("metadata.json")
                    extracted = archive.extractfile(member)
                    if extracted:
                        parsed = json.loads(extracted.read().decode("utf-8"))
                        metadata = parsed if isinstance(parsed, dict) else {}
                except (KeyError, tarfile.TarError, json.JSONDecodeError, UnicodeDecodeError):
                    metadata = {}
            items.append({
                "name": path.name,
                "size": stat.st_size,
                "sizeLabel": human_bytes(stat.st_size),
                "createdAt": int(metadata.get("createdAt") or stat.st_mtime),
                "version": str(metadata.get("version") or "unknown"),
                "databaseSize": int(metadata.get("databaseSize") or 0),
            })
        except OSError:
            continue
    return items


def prune_system_backups() -> int:
    items = sorted(BACKUP_ROOT.glob("player-panel-backup-*.tar.gz"), key=lambda item: item.stat().st_mtime, reverse=True)
    removed = 0
    for path in items[backup_retention():]:
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def create_system_backup(actor: str = "system") -> dict[str, Any]:
    timestamp = datetime.now(timezone.utc)
    name = f"player-panel-backup-{timestamp.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    final_path = BACKUP_ROOT / name
    if final_path.exists():
        name = f"player-panel-backup-{timestamp.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}.tar.gz"
        final_path = BACKUP_ROOT / name
    with MAINTENANCE_LOCK, tempfile.TemporaryDirectory(prefix="player-panel-backup-", dir=DATA_ROOT) as tmp_name:
        tmp = Path(tmp_name)
        snapshot = tmp / "player-panel.db"
        database_snapshot(snapshot)
        metadata = {
            "format": 1,
            "product": "Player Panel",
            "version": APP_VERSION,
            "createdAt": now_ts(),
            "createdAtIso": iso_time(),
            "actor": actor,
            "databaseSize": snapshot.stat().st_size,
            "containsSecrets": True,
            "restoreScope": ["database", "vapid-key"],
        }
        (tmp / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp / "metadata.json", 0o600)
        if VAPID_PRIVATE_KEY_PATH.is_file():
            shutil.copy2(VAPID_PRIVATE_KEY_PATH, tmp / "vapid_private.pem")
            os.chmod(tmp / "vapid_private.pem", 0o600)
        secrets_dir = tmp / "secrets"
        secrets_dir.mkdir(mode=0o700)
        for filename, value in secret_backup_values().items():
            target = secrets_dir / filename
            target.write_text(value, encoding="utf-8")
            os.chmod(target, 0o600)
        manual = {
            "note": "Secrets are included for manual recovery. Restoring from the panel replaces SQLite and the VAPID key; Docker secrets must be restored on the host.",
            "secretFiles": sorted(secret_backup_values()),
        }
        (tmp / "RESTORE.json").write_text(json.dumps(manual, indent=2, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp / "RESTORE.json", 0o600)
        partial = final_path.with_suffix(final_path.suffix + ".partial")
        with tarfile.open(partial, "w:gz") as archive:
            for item in sorted(tmp.rglob("*")):
                archive.add(item, arcname=item.relative_to(tmp), recursive=False)
        os.chmod(partial, 0o600)
        os.replace(partial, final_path)
    removed = prune_system_backups()
    return {"name": name, "size": final_path.stat().st_size, "sizeLabel": human_bytes(final_path.stat().st_size), "createdAt": metadata["createdAt"], "removedOld": removed}


def restore_system_backup(name: str) -> dict[str, Any]:
    global VAPID_PUBLIC_KEY
    filename = safe_backup_name(name)
    source = BACKUP_ROOT / filename
    if not source.is_file():
        raise ValueError("Backup not found")
    rollback_name = f"player-panel-backup-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-rollback-{secrets.token_hex(3)}.tar.gz"
    with MAINTENANCE_LOCK:
        MAINTENANCE_MODE.set()
        try:
            with tempfile.TemporaryDirectory(prefix="player-panel-restore-", dir=DATA_ROOT) as tmp_name:
                tmp = Path(tmp_name)
                with tarfile.open(source, "r:gz") as archive:
                    members = archive.getmembers()
                    for member in members:
                        resolved = (tmp / member.name).resolve()
                        try:
                            resolved.relative_to(tmp.resolve())
                        except ValueError as exc:
                            raise ValueError("The backup contains unsafe paths") from exc
                        if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                            raise ValueError("The backup contains disallowed items")
                    for member in members:
                        archive.extract(member, tmp, filter="data")
                restored_db = tmp / "player-panel.db"
                if not restored_db.is_file():
                    raise ValueError("The backup does not contain player-panel.db")
                with sqlite3.connect(restored_db) as check_db:
                    result = check_db.execute("PRAGMA integrity_check").fetchone()
                    if not result or str(result[0]).lower() != "ok":
                        raise ValueError("The backup database is damaged")
                # Create an automatic rollback package before replacing live state.
                rollback_path = BACKUP_ROOT / rollback_name
                rollback_snapshot_dir = tmp / "rollback"
                rollback_snapshot_dir.mkdir()
                database_snapshot(rollback_snapshot_dir / "player-panel.db")
                if VAPID_PRIVATE_KEY_PATH.is_file():
                    shutil.copy2(VAPID_PRIVATE_KEY_PATH, rollback_snapshot_dir / "vapid_private.pem")
                (rollback_snapshot_dir / "metadata.json").write_text(json.dumps({"version": APP_VERSION, "createdAt": now_ts(), "type": "pre-restore"}), encoding="utf-8")
                with tarfile.open(rollback_path, "w:gz") as archive:
                    for item in rollback_snapshot_dir.iterdir():
                        archive.add(item, arcname=item.name)
                os.chmod(rollback_path, 0o600)
                # Replace SQLite atomically and remove stale WAL files.
                with sqlite3.connect(DB_PATH, timeout=30) as db:
                    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                replacement = DB_PATH.with_name(DB_PATH.name + ".restore")
                shutil.copy2(restored_db, replacement)
                os.chmod(replacement, 0o600)
                os.replace(replacement, DB_PATH)
                for suffix in ("-wal", "-shm"):
                    stale = Path(str(DB_PATH) + suffix)
                    if stale.exists():
                        stale.unlink()
                restored_vapid = tmp / "vapid_private.pem"
                if restored_vapid.is_file():
                    shutil.copy2(restored_vapid, VAPID_PRIVATE_KEY_PATH)
                    os.chmod(VAPID_PRIVATE_KEY_PATH, 0o600)
                    VAPID_PUBLIC_KEY = ensure_vapid_keys()
                init_db()
                load_connection_overrides()
        finally:
            MAINTENANCE_MODE.clear()
    return {"name": filename, "rollback": rollback_name, "restoredAt": now_ts()}


def run_system_maintenance() -> dict[str, Any]:
    timestamp = now_ts()
    metrics_days = min(max(int(setting_float("metrics.retention_days", METRICS_RETENTION_DAYS)), 1), 365)
    audit_days = min(max(int(setting_float("system.audit_retention_days", 180)), 7), 3650)
    alert_days = min(max(int(setting_float("system.alert_retention_days", 90)), 7), 3650)
    with MAINTENANCE_LOCK:
        with db_connect() as db:
            before = {
                "metrics": int(db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]),
                "audit": int(db.execute("SELECT COUNT(*) FROM audit").fetchone()[0]),
                "alerts": int(db.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]),
                "sessions": int(db.execute("SELECT COUNT(*) FROM web_sessions").fetchone()[0]),
                "push": int(db.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]),
            }
            db.execute("DELETE FROM metrics WHERE ts < ?", (timestamp - metrics_days * 86400,))
            db.execute("DELETE FROM audit WHERE ts < ?", (timestamp - audit_days * 86400,))
            db.execute("DELETE FROM alerts WHERE ts < ?", (timestamp - alert_days * 86400,))
            db.execute("DELETE FROM web_sessions WHERE expires_at < ?", (timestamp,))
            db.execute("DELETE FROM push_subscriptions WHERE enabled=0 AND updated_at < ?", (timestamp - 30 * 86400,))
            after = {
                "metrics": int(db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]),
                "audit": int(db.execute("SELECT COUNT(*) FROM audit").fetchone()[0]),
                "alerts": int(db.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]),
                "sessions": int(db.execute("SELECT COUNT(*) FROM web_sessions").fetchone()[0]),
                "push": int(db.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]),
            }
            db.commit()
        with sqlite3.connect(DB_PATH, timeout=60, isolation_level=None) as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            db.execute("VACUUM")
    return {"before": before, "after": after, "removed": {key: before[key] - after[key] for key in before}, "databaseSize": DB_PATH.stat().st_size if DB_PATH.exists() else 0}


def onboarding_state() -> dict[str, Any]:
    preferred = setting_value("onboarding.preferred_mode", PANEL_SETUP_MODE).strip().lower()
    if preferred not in {"choose", "manual", "crafty", "later"}:
        preferred = "choose"
    completed = setting_value("onboarding.completed", "0").strip().lower() in {"1", "true", "yes", "on"}
    with db_connect() as db:
        plugin_ready = bool(db.execute(
            "SELECT 1 FROM server_profiles WHERE active=1 AND plugin_enabled=1 "
            "AND TRIM(plugin_api_url)<>'' AND TRIM(plugin_token)<>'' LIMIT 1"
        ).fetchone())
        crafty_installation_ready = bool(db.execute(
            "SELECT 1 FROM crafty_connections WHERE active=1 AND TRIM(api_url)<>'' "
            "AND (TRIM(api_token)<>'' OR (TRIM(username)<>'' AND TRIM(password)<>'')) LIMIT 1"
        ).fetchone())
        crafty_ready = bool(db.execute(
            "SELECT 1 FROM server_profiles WHERE active=1 AND source_type='crafty' "
            "AND crafty_connection_id>0 AND TRIM(crafty_server_id)<>'' LIMIT 1"
        ).fetchone())
    effective_complete = completed or plugin_ready or crafty_ready
    return {
        "required": not effective_complete,
        "completed": effective_complete,
        "preferredMode": preferred,
        "pluginConfigured": plugin_ready,
        "craftyConfigured": crafty_ready,
        "craftyInstallationConfigured": crafty_installation_ready,
    }


def complete_onboarding(mode: str) -> dict[str, Any]:
    normalized = str(mode or "later").strip().lower()
    if normalized not in {"manual", "crafty", "later"}:
        raise ValueError("Invalid initial setup mode")
    timestamp = now_ts()
    with db_connect() as db:
        for key, value in {
            "onboarding.completed": "1",
            "onboarding.preferred_mode": normalized,
        }.items():
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, value, timestamp),
            )
    return onboarding_state()


def system_settings() -> dict[str, Any]:
    return {
        "metricsRetentionDays": int(setting_float("metrics.retention_days", METRICS_RETENTION_DAYS)),
        "backupRetention": backup_retention(),
        "auditRetentionDays": int(setting_float("system.audit_retention_days", 180)),
        "alertRetentionDays": int(setting_float("system.alert_retention_days", 90)),
        "timezone": setting_value("system.timezone", DEFAULT_TIMEZONE),
    }


def update_system_settings(data: dict[str, Any]) -> dict[str, Any]:
    timezone_name = str(data.get("timezone", setting_value("system.timezone", DEFAULT_TIMEZONE))).strip()
    try:
        ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Invalid IANA time zone")
    values = {
        "metrics.retention_days": min(max(int(data.get("metricsRetentionDays", METRICS_RETENTION_DAYS)), 1), 365),
        "system.backup_retention": min(max(int(data.get("backupRetention", 10)), 1), 50),
        "system.audit_retention_days": min(max(int(data.get("auditRetentionDays", 180)), 7), 3650),
        "system.alert_retention_days": min(max(int(data.get("alertRetentionDays", 90)), 7), 3650),
        "system.timezone": timezone_name,
    }
    with db_connect() as db:
        for key, value in values.items():
            db.execute("INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", (key, str(value), now_ts()))
    prune_system_backups()
    return system_settings()


def system_diagnostics() -> dict[str, Any]:
    disk = shutil.disk_usage(DATA_ROOT)
    database = {"path": str(DB_PATH), "exists": DB_PATH.is_file(), "size": DB_PATH.stat().st_size if DB_PATH.is_file() else 0, "integrity": "unknown", "tables": {}}
    try:
        with db_connect() as db:
            check = db.execute("PRAGMA quick_check").fetchone()
            database["integrity"] = str(check[0]) if check else "unknown"
            for table in ("users", "web_sessions", "push_subscriptions", "metrics", "audit", "alerts", "sessions", "places"):
                database["tables"][table] = int(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except sqlite3.Error as exc:
        database["integrity"] = f"error: {exc}"
    secret_files = []
    for env_name, file_env in (
        ("PLAYER_PANEL_API_TOKEN", "PLAYER_PANEL_API_TOKEN_FILE"),
        ("ADMIN_PASSWORD", "ADMIN_PASSWORD_FILE"),
        ("SESSION_SECRET", "SESSION_SECRET_FILE"),
        ("CRAFTY_USERNAME", "CRAFTY_USERNAME_FILE"),
        ("CRAFTY_PASSWORD", "CRAFTY_PASSWORD_FILE"),
        ("CRAFTY_API_TOKEN", "CRAFTY_API_TOKEN_FILE"),
    ):
        path_text = os.getenv(file_env, "").strip()
        item: dict[str, Any] = {"name": env_name, "file": path_text or None, "configured": bool(read_secret(env_name, file_env))}
        if path_text:
            try:
                stat = Path(path_text).stat()
                mode = stat.st_mode & 0o777
                item.update({"exists": True, "mode": f"{mode:03o}", "uid": stat.st_uid, "gid": stat.st_gid, "safe": (mode & 0o077) == 0})
            except OSError as exc:
                item.update({"exists": False, "safe": False, "error": str(exc)})
        secret_files.append(item)
    plugin_status, plugin_body = upstream_request("GET", "/api/v1/health", quiet=True)
    plugin = parse_json_bytes(plugin_body)
    crafty = crafty_status()
    return {
        "success": True,
        "generatedAt": now_ts(),
        "application": {
            "name": "Player Panel",
            "version": APP_VERSION,
            "python": platform.python_version(),
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "pid": os.getpid(),
            "uptimeSeconds": max(0, now_ts() - APP_STARTED_AT),
            "timezone": system_settings().get("timezone", DEFAULT_TIMEZONE),
        },
        "plugin": {"available": int(plugin_status) == 200, "status": int(plugin_status), "data": plugin},
        "crafty": crafty,
        "database": database,
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free, "percent": round((disk.used / disk.total * 100) if disk.total else 0, 1)},
        "push": {"vapidReady": VAPID_PRIVATE_KEY_PATH.is_file(), "subject": VAPID_SUBJECT, "publicKeyReady": bool(VAPID_PUBLIC_KEY), "queueSize": PUSH_DISPATCHER.queue.qsize() if PUSH_DISPATCHER else 0},
        "secrets": secret_files,
        "runtime": {"monitorIntervalSeconds": MONITOR_INTERVAL, "apiDownFailureThreshold": API_DOWN_FAILURE_THRESHOLD, "apiDownGraceSeconds": API_DOWN_GRACE_SECONDS, "pluginEventIntervalSeconds": PLUGIN_EVENT_INTERVAL, "liveHeartbeatSeconds": LIVE_EVENT_HEARTBEAT_SECONDS, "metricsSampleIntervalSeconds": METRICS_SAMPLE_INTERVAL, "sessionTtlSeconds": SESSION_TTL, "cookieSecure": COOKIE_SECURE, "trustProxy": TRUST_PROXY, "trustedProxyCidrs": [str(network) for network in TRUSTED_PROXY_NETWORKS]},
        "connections": connection_settings_public(),
        "settings": system_settings(),
        "backups": list_system_backups(),
    }


def diagnostic_report() -> bytes:
    payload = system_diagnostics()
    # Keep the report safe to share: no tokens, passwords, endpoints or subscription keys.
    payload["secrets"] = [{key: item.get(key) for key in ("name", "file", "configured", "exists", "mode", "uid", "gid", "safe", "error") if key in item} for item in payload.get("secrets", [])]
    return json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")

def validate_place(data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name", "")).strip()
    world = str(data.get("world", "")).strip()
    if not (1 <= len(name) <= 50):
        raise ValueError("The name must be between 1 and 50 characters")
    if not (1 <= len(world) <= 100):
        raise ValueError("Select to valid world")
    try:
        x = float(data.get("x"))
        y = float(data.get("y"))
        z = float(data.get("z"))
        yaw = float(data.get("yaw", 0))
        pitch = float(data.get("pitch", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("The coordinates are invalid") from exc
    if any(abs(value) > 30_000_000 for value in (x, z)) or not (-4096 <= y <= 4096):
        raise ValueError("The coordinates are outside the allowed range")
    return {"name": name, "world": world, "x": x, "y": y, "z": z, "yaw": yaw, "pitch": pitch}


class Handler(BaseHTTPRequestHandler):
    server_version = "PlayerPanelWeb"
    sys_version = ""

    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("%s %s", self.client_ip(), fmt % args)

    def client_ip(self) -> str:
        peer = normalize_ip_address(self.client_address[0]) or str(self.client_address[0])
        if not proxy_peer_is_trusted(peer):
            return peer

        # Nginx Proxy Manager normally provides X-Forwarded-For. The remaining
        # headers are fallbacks for Cloudflare, other Nginx configurations and
        # RFC 7239 proxies. Headers are accepted only from to trusted peer.
        forwarded_for = self.headers.get("X-Forwarded-For", "")
        for raw in forwarded_for.split(","):
            candidate = normalize_ip_address(raw)
            if candidate:
                return candidate
        for header_name in ("CF-Connecting-IP", "True-Client-IP", "X-Real-IP"):
            candidate = normalize_ip_address(self.headers.get(header_name, ""))
            if candidate:
                return candidate
        candidate = forwarded_header_ip(self.headers.get("Forwarded", ""))
        return candidate or peer

    def select_request_server(self, query: dict[str, list[str]] | None = None) -> int:
        requested = self.headers.get("X-Player-Panel-Server", "").strip()
        if not requested and query:
            requested = str(query.get("server", [""])[0]).strip()
        return set_current_server_id(requested or default_server_id())

    def security_headers(self, cache_control: str = "no-store") -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        if COOKIE_SECURE:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; frame-src 'self' http: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        self.send_header("Cache-Control", cache_control)

    def send_json(self, status: int, payload: dict[str, Any] | list[Any] | bytes) -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def write_sse(self, event_type: str, payload: dict[str, Any], event_id: int | None = None) -> None:
        lines: list[str] = []
        if event_id is not None:
            lines.append(f"id: {event_id}")
        lines.append(f"event: {event_type}")
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        for line in encoded.splitlines() or [""]:
            lines.append(f"data: {line}")
        self.wfile.write(("\n".join(lines) + "\n\n").encode("utf-8"))
        self.wfile.flush()

    def serve_live_events(self, session: dict[str, Any]) -> None:
        server_id = current_server_id()
        current_id = LIVE_EVENTS.current_id()
        try:
            requested_id = int(self.headers.get("Last-Event-ID", "0") or 0)
        except ValueError:
            requested_id = 0
        cursor = requested_id if 0 < requested_id <= current_id else current_id

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.security_headers("no-cache, no-transform")
        self.end_headers()
        self.wfile.write(b"retry: 3000\n\n")
        self.write_sse("ready", {"version": APP_VERSION, "eventId": current_id, "ts": now_ts(), "serverId": server_id})
        if user_can(session, "dashboard.view") or user_can(session, "players.view"):
            live_state = get_monitor(server_id).snapshot_live_state()
            self.write_sse("players", live_state)
        last_session_check = time.monotonic()

        try:
            while True:
                events = LIVE_EVENTS.wait_after(cursor, LIVE_EVENT_HEARTBEAT_SECONDS)
                if events:
                    for event in events:
                        event_id = int(event.get("id") or cursor)
                        if int(event.get("serverId") or 0) != server_id:
                            cursor = max(cursor, event_id)
                            continue
                        cursor = max(cursor, event_id)
                        if event.get("event") == "alert" and not user_can(session, "alerts.view"):
                            continue
                        if event.get("event") == "players" and not (user_can(session, "dashboard.view") or user_can(session, "players.view")):
                            continue
                        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                        self.write_sse(str(event.get("event") or "message"), payload, event_id)
                else:
                    self.wfile.write(f": keepalive {now_ts()}\n\n".encode("utf-8"))
                    self.wfile.flush()

                if time.monotonic() - last_session_check >= 60:
                    refreshed = self.session()
                    if not refreshed:
                        break
                    session = refreshed
                    last_session_check = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass

    def send_bytes_download(self, body: bytes, filename: str, content_type: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.security_headers("no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_download(self, path: Path, filename: str, content_type: str) -> None:
        if not path.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"success": False, "message": "File not found"})
            return
        try:
            body = path.read_bytes()
        except OSError as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"success": False, "message": str(exc)})
            return
        self.send_bytes_download(body, filename, content_type)

    def read_json(self, max_bytes: int = 65536) -> tuple[dict[str, Any], bytes]:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size < 0 or size > max_bytes:
            raise ValueError("Request is too large")
        raw = self.rfile.read(size) if size else b"{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data, raw

    def session(self) -> dict[str, Any] | None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get("pp_session")
        return validate_session(morsel.value if morsel else None, self.client_ip())

    def require_session(self, mutate: bool = False) -> dict[str, Any] | None:
        session = self.session()
        if not session:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"success": False, "error": "LOGIN_REQUIRED", "message": "Authentication required"})
            return None
        if mutate:
            requested_with = self.headers.get("X-Requested-With", "")
            csrf = self.headers.get("X-CSRF-Token", "")
            if requested_with != "PlayerPanel" or not hmac.compare_digest(str(session.get("csrf", "")), csrf):
                self.send_json(HTTPStatus.FORBIDDEN, {"success": False, "error": "CSRF_FAILED", "message": "Invalid request token"})
                return None
        return session

    def require_permission(self, permission: str, mutate: bool = False) -> dict[str, Any] | None:
        session = self.require_session(mutate=mutate)
        if not session:
            return None
        if not user_can(session, permission):
            self.send_json(HTTPStatus.FORBIDDEN, {"success": False, "error": "FORBIDDEN", "message": "You do not have permission to use this feature"})
            return None
        return session

    @staticmethod
    def actor_name(session: dict[str, Any] | None) -> str:
        if not session:
            return "system"
        return str(session.get("display_name") or session.get("username") or "user")

    def ensure_permission(self, session: dict[str, Any], permission: str) -> bool:
        if user_can(session, permission):
            return True
        self.send_json(HTTPStatus.FORBIDDEN, {"success": False, "error": "FORBIDDEN", "message": "You do not have permission to use this feature"})
        return False

    @staticmethod
    def local_get_permission(path: str) -> str | None:
        return {
            "/api/local/dashboard": "dashboard.view", "/api/local/places": "places.view",
            "/api/local/history": "history.view", "/api/local/sessions": "sessions.view",
            "/api/local/alerts": "alerts.view", "/api/local/metrics": "metrics.view", "/api/local/crafty": "crafty.view",
            "/api/local/crafty/server": "crafty.view", "/api/local/crafty/logs": "crafty.logs",
            "/api/local/crafty/backups": "server.backup",
            "/api/local/system": "system.view",
            "/api/local/system/backups": "system.backup",
            "/api/local/system/report": "system.view",
            "/api/local/servers": "system.view",
            "/api/local/crafty/connections": "system.view",
        }.get(path)

    @staticmethod
    def proxy_get_permission(path: str) -> str:
        if path.endswith("/inventory"):
            return "inventory.view"
        if path == "/api/v1/server":
            return "world.view"
        return "players.view"

    @staticmethod
    def proxy_post_permission(path: str) -> str:
        if path == "/api/v1/world/control": return "world.control"
        if path == "/api/v1/world/safe-position": return "places.manage"
        if path in {"/api/v1/whitelist/add", "/api/v1/whitelist/update"} or path.endswith("/whitelist"): return "players.whitelist"
        action = path.rsplit("/", 1)[-1]
        return {"heal":"players.heal", "feed":"players.feed", "gamemode":"players.gamemode", "teleport":"players.teleport", "kick":"players.kick", "ban":"players.ban", "unban":"players.ban", "operator":"players.operator", "clear-inventory":"players.clear_inventory"}.get(action, "players.view")

    @staticmethod
    def local_post_permission(path: str, data: dict[str, Any]) -> str | None:
        if path.startswith("/api/local/system/restore"): return "system.restore"
        if path.startswith("/api/local/system/backup"): return "system.backup"
        if path.startswith("/api/local/system/maintenance"): return "system.maintain"
        if path.startswith("/api/local/system/settings"): return "system.settings"
        if path.startswith("/api/local/system/connections"): return "system.settings"
        if path.startswith("/api/local/onboarding/"): return "system.settings"
        if path.startswith("/api/local/crafty/connections/"): return "system.settings"
        if path.startswith("/api/local/servers/"): return "system.settings"
        if path.startswith("/api/local/system/backups/delete"): return "system.backup"
        if path.startswith("/api/local/users/"): return "users.manage"
        if path.startswith("/api/local/account/"): return None
        if path.startswith("/api/local/places/"): return "places.manage"
        if path == "/api/local/bulk": return "bulk.manage"
        if path == "/api/local/alerts/read": return "alerts.manage"
        if path == "/api/local/metrics/settings": return "metrics.manage"
        if path == "/api/local/crafty/action":
            return "server.backup" if str(data.get("action", "")) == "backup_server" else "server.control"
        return None

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        self.select_request_server(query)
        if path == "/healthz":
            self.send_json(HTTPStatus.OK, {"status": "maintenance" if MAINTENANCE_MODE.is_set() else "ok", "version": APP_VERSION})
            return
        if path.startswith("/media/item/"):
            if self.require_session():
                self.serve_item_image(path)
            return
        if path.startswith("/media/player/"):
            if self.require_session():
                self.serve_player_image(path)
            return
        if path == "/api/session":
            session = self.session()
            if not session:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"authenticated": False})
                return
            server_id = current_server_id()
            self.send_json(HTTPStatus.OK, {
                "authenticated": True, "csrf": session["csrf"], "version": APP_VERSION, "user": public_user(session),
                "connections": connection_flags_public(server_id), "servers": list_server_profiles_public(),
                "selectedServerId": server_id, "timeZone": system_settings().get("timezone", DEFAULT_TIMEZONE),
                "minecraftAuthMode": MINECRAFT_AUTH_MODE, "onboarding": onboarding_state(),
            })
            return
        if path.startswith("/api/local/system/backups/") and path.endswith("/download"):
            session = self.require_permission("system.backup")
            if not session:
                return
            parts = path.split("/")
            try:
                filename = safe_backup_name(parts[-2])
            except ValueError as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"success": False, "message": str(exc)})
                return
            self.send_download(BACKUP_ROOT / filename, filename, "application/gzip")
            return
        if path == "/api/local/system/report/download":
            session = self.require_permission("system.view")
            if not session:
                return
            body = diagnostic_report()
            self.send_bytes_download(body, f"player-panel-diagnostic-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json", "application/json; charset=utf-8")
            return
        if path == "/api/local/live":
            session = self.require_session()
            if not session:
                return
            if not (user_can(session, "alerts.view") or user_can(session, "players.view") or user_can(session, "dashboard.view")):
                self.send_json(HTTPStatus.FORBIDDEN, {"success": False, "error": "FORBIDDEN", "message": "You do not have permission to access live events"})
                return
            self.serve_live_events(session)
            return
        if path.startswith("/api/local/"):
            session = self.require_session()
            if not session:
                return
            permission = self.local_get_permission(path)
            if permission and not self.ensure_permission(session, permission):
                return
            self.handle_local_get(path, query)
            return
        if path.startswith("/api/v1/"):
            session = self.require_session()
            if not session:
                return
            if not self.ensure_permission(session, self.proxy_get_permission(path)):
                return
            if not any(pattern.fullmatch(path) for pattern in ALLOWED_GET):
                self.send_json(HTTPStatus.NOT_FOUND, {"success": False, "error": "NOT_FOUND", "message": "Endpoint not found"})
                return
            status, body = upstream_request("GET", path)
            if status >= 500:
                fallback = paused_empty_proxy_fallback(path)
                if fallback is not None:
                    status, body = fallback
            if status == HTTPStatus.OK:
                body = enrich_player_history(path, body)
            self.send_json(status, body)
            return
        self.serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        self.select_request_server(parse_qs(parsed.query))
        if path == "/api/session":
            self.login()
            return
        if path == "/api/logout":
            if not self.require_session(mutate=True):
                return
            cookie = SimpleCookie(); cookie.load(self.headers.get("Cookie", "")); morsel = cookie.get("pp_session")
            delete_session(morsel.value if morsel else None)
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Set-Cookie", self.cookie_header("pp_session", "", max_age=0))
            self.security_headers()
            self.end_headers()
            return
        if path.startswith("/api/local/"):
            session = self.require_session(mutate=True)
            if not session:
                return
            try:
                data, _ = self.read_json()
            except ValueError as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"success": False, "error": "BAD_REQUEST", "message": str(exc)})
                return
            permission = self.local_post_permission(path, data)
            if permission and not self.ensure_permission(session, permission):
                return
            self.handle_local_post(path, data)
            return
        if path.startswith("/api/v1/"):
            session = self.require_session(mutate=True)
            if not session:
                return
            if not any(pattern.fullmatch(path) for pattern in ALLOWED_POST):
                self.send_json(HTTPStatus.NOT_FOUND, {"success": False, "error": "NOT_FOUND", "message": "Endpoint not found"})
                return
            try:
                data, raw = self.read_json()
            except ValueError as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"success": False, "error": "BAD_REQUEST", "message": str(exc)})
                return
            if not self.ensure_permission(session, self.proxy_post_permission(path)):
                return
            if path == "/api/v1/whitelist/add" and MINECRAFT_AUTH_MODE == "offline":
                supplied_uuid = str(data.get("uuid") or "").strip()
                player_name_value = str(data.get("name") or "").strip()
                if not supplied_uuid and re.fullmatch(r"[A-Za-z0-9_]{3,16}", player_name_value):
                    data = dict(data)
                    data["uuid"] = offline_player_uuid(player_name_value)
                    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            status, body = upstream_request("POST", path, raw)
            self.audit_proxy_action(path, data, status)
            if path == "/api/v1/world/control" and 200 <= int(status) < 300:
                response_payload = parse_json_bytes(body)
                changed_world = response_payload.get("world")
                if isinstance(changed_world, dict) and changed_world.get("name"):
                    LIVE_EVENTS.publish("worlds", {
                        "updatedAt": now_ts(),
                        "worlds": [changed_world],
                    })
            self.send_json(status, body)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"success": False, "error": "NOT_FOUND"})

    def handle_local_get(self, path: str, query: dict[str, list[str]]) -> None:
        try:
            if path == "/api/local/dashboard":
                self.send_json(HTTPStatus.OK, dashboard_payload())
            elif path == "/api/local/servers":
                self.send_json(HTTPStatus.OK, {"success": True, "servers": list_server_profiles_public(), "selectedServerId": current_server_id()})
            elif path == "/api/local/places":
                self.send_json(HTTPStatus.OK, {"success": True, "places": query_places()})
            elif path == "/api/local/history":
                limit = int(query.get("limit", ["100"])[0])
                offset = int(query.get("offset", ["0"])[0])
                category = query.get("category", [""])[0]
                self.send_json(HTTPStatus.OK, {"success": True, "history": query_audit(limit, offset, category)})
            elif path == "/api/local/sessions":
                limit = int(query.get("limit", ["100"])[0])
                self.send_json(HTTPStatus.OK, {"success": True, "sessions": query_sessions(limit)})
            elif path == "/api/local/alerts":
                since = int(query.get("since", ["0"])[0])
                limit = int(query.get("limit", ["50"])[0])
                self.send_json(HTTPStatus.OK, {"success": True, "alerts": query_alerts(since, limit)})
            elif path == "/api/local/metrics":
                hours = int(query.get("hours", ["24"])[0])
                bucket = int(query.get("bucket", ["300"])[0])
                self.send_json(HTTPStatus.OK, query_metrics(hours, bucket))
            elif path == "/api/local/users":
                session = self.require_permission("users.manage")
                if not session: return
                with db_connect() as db:
                    rows = db.execute("SELECT * FROM users ORDER BY active DESC, username COLLATE NOCASE").fetchall()
                    counts = {int(row["user_id"]): int(row["count"]) for row in db.execute("SELECT user_id, COUNT(*) AS count FROM web_sessions WHERE expires_at>=? GROUP BY user_id", (now_ts(),)).fetchall()}
                users = []
                for row in rows:
                    item = public_user(row)
                    item["activeSessions"] = counts.get(int(row["id"]), 0)
                    try: item["permissionOverrides"] = json.loads(row["permissions_json"] or "{}")
                    except json.JSONDecodeError: item["permissionOverrides"] = {"allow": [], "deny": []}
                    users.append(item)
                self.send_json(HTTPStatus.OK, {"success": True, "users": users, "roles": ROLE_LABELS, "availablePermissions": ALL_PERMISSIONS})
            elif path == "/api/local/account/sessions":
                session = self.require_session()
                if not session: return
                with db_connect() as db:
                    rows = db.execute("SELECT token_hash, created_at, last_seen, expires_at, ip, user_agent FROM web_sessions WHERE user_id=? ORDER BY last_seen DESC", (int(session["user_id"]),)).fetchall()
                payload_sessions = []
                for row in rows:
                    item = row_dict(row); item["current"] = item.pop("token_hash") == session["token_hash"]; payload_sessions.append(item)
                self.send_json(HTTPStatus.OK, {"success": True, "sessions": payload_sessions})
            elif path == "/api/local/account/dashboard-layout":
                session = self.require_session()
                if not session: return
                self.send_json(HTTPStatus.OK, {"success": True, "layout": dashboard_layout_for_user(int(session["user_id"]))})
            elif path == "/api/local/crafty/connections":
                selected_connection_id = 0
                if current_server_id() > 0:
                    selected_connection_id = int(server_profile_config()["crafty"].get("connectionId") or 0)
                self.send_json(HTTPStatus.OK, {
                    "success": True,
                    "connections": list_crafty_connections_public(),
                    "selectedConnectionId": selected_connection_id,
                })
            elif path == "/api/local/crafty":
                self.send_json(HTTPStatus.OK, {"success": True, "crafty": crafty_status()})
            elif path == "/api/local/crafty/server":
                force = str(query.get("force", ["0"])[0]).lower() in {"1", "true", "yes", "on"}
                self.send_json(
                    HTTPStatus.OK,
                    {"success": True, "crafty": crafty_server_overview(include_logs=False, include_backups=False, force=force)},
                )
            elif path == "/api/local/crafty/logs":
                limit = min(max(int(query.get("limit", [str(CRAFTY_LOG_LIMIT)])[0]), 20), 500)
                server_path = quote(str(server_profile_config()["crafty"].get("serverId") or ""), safe="-")
                status, response = crafty_request(
                    "GET",
                    f"/api/v2/servers/{server_path}/logs?file=false&colors=false&raw=false&html=false",
                )
                self.send_json(
                    HTTPStatus.OK if 200 <= int(status) < 300 else status,
                    {"success": 200 <= int(status) < 300, "logs": normalize_crafty_logs(response, limit)},
                )
            elif path == "/api/local/crafty/backups":
                server_path = quote(str(server_profile_config()["crafty"].get("serverId") or ""), safe="-")
                status, response = crafty_request("GET", f"/api/v2/servers/{server_path}/backups")
                self.send_json(
                    HTTPStatus.OK if 200 <= int(status) < 300 else status,
                    {"success": 200 <= int(status) < 300, "backups": normalize_backup_configs(response)},
                )
            elif path == "/api/local/system":
                self.send_json(HTTPStatus.OK, system_diagnostics())
            elif path == "/api/local/system/backups":
                self.send_json(HTTPStatus.OK, {"success": True, "backups": list_system_backups(), "settings": system_settings()})
            elif path == "/api/local/system/report":
                self.send_json(HTTPStatus.OK, system_diagnostics())
            elif path == "/api/local/push":
                session = self.session()
                if not session:
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"success": False, "error": "LOGIN_REQUIRED"})
                    return
                self.send_json(HTTPStatus.OK, {
                    "success": True,
                    "configured": bool(VAPID_PUBLIC_KEY),
                    "publicKey": VAPID_PUBLIC_KEY,
                    "keyId": VAPID_PUBLIC_KEY_ID,
                    "eventTypes": sorted(PUSH_EVENT_TYPES - {"test"}),
                    "defaultEvents": sorted(PUSH_DEFAULT_EVENTS),
                    "subscriptions": push_subscriptions_for_user(int(session["user_id"])),
                })
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"success": False, "error": "NOT_FOUND"})
        except (ValueError, sqlite3.Error) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"success": False, "error": "BAD_REQUEST", "message": str(exc)})

    def handle_local_post(self, path: str, data: dict[str, Any]) -> None:
        try:
            current = self.session()
            actor = self.actor_name(current)
            if path == "/api/local/servers/save":
                profile = save_server_profile(data)
                set_current_server_id(profile["id"])
                record_audit("system", "server-profile-save", "success", actor=actor, details={"serverId": profile["id"], "name": profile["name"]}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "server": profile, "servers": list_server_profiles_public(), "selectedServerId": profile["id"]})
            elif path == "/api/local/servers/delete":
                profile_id = int(data.get("id") or 0)
                if profile_id <= 0:
                    raise ValueError("Invalid server")
                old_name = server_profile_config(profile_id)["name"]
                delete_server_profile(profile_id)
                set_current_server_id(default_server_id())
                record_audit("system", "server-profile-delete", "success", actor=actor, details={"serverId": profile_id, "name": old_name}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "servers": list_server_profiles_public(), "selectedServerId": current_server_id()})
            elif path == "/api/local/users/save":
                session = self.require_permission("users.manage")
                if not session: return
                user_id = int(data.get("id") or 0)
                username = str(data.get("username", "")).strip()
                display_name = str(data.get("displayName", "")).strip() or username
                role = str(data.get("role", "viewer")).strip()
                password = str(data.get("password", ""))
                active = 1 if bool(data.get("active", True)) else 0
                if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username): raise ValueError("Invalid username")
                if len(display_name) < 2 or len(display_name) > 60: raise ValueError("Invalid display name")
                if role not in ROLE_PERMISSIONS: raise ValueError("Invalid role")
                overrides = data.get("permissions", {})
                if not isinstance(overrides, dict): overrides = {}
                clean_overrides = {"allow": [p for p in overrides.get("allow", []) if p in ALL_PERMISSIONS], "deny": [p for p in overrides.get("deny", []) if p in ALL_PERMISSIONS]}
                timestamp = now_ts()
                with db_connect() as db:
                    if user_id:
                        existing = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                        if not existing: raise ValueError("User not found")
                        if int(existing["id"]) == int(session["user_id"]) and not active: raise ValueError("No puedes desactivar tu propia cuenta")
                        if existing["role"] == "admin" and (role != "admin" or not active) and int(db.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]) <= 1: raise ValueError("Debe existir al menos un administrador activo")
                        db.execute("UPDATE users SET username=?, display_name=?, role=?, permissions_json=?, active=?, updated_at=? WHERE id=?", (username, display_name, role, json.dumps(clean_overrides), active, timestamp, user_id))
                        if password:
                            salt, digest = password_digest(password)
                            db.execute("UPDATE users SET password_hash=?, password_salt=?, session_version=session_version+1, updated_at=? WHERE id=?", (digest, salt, timestamp, user_id))
                            db.execute("DELETE FROM web_sessions WHERE user_id=?", (user_id,))
                    else:
                        if not password: raise ValueError("A password is required for new users")
                        salt, digest = password_digest(password)
                        cursor = db.execute("INSERT INTO users(username, display_name, password_hash, password_salt, role, permissions_json, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)", (username, display_name, digest, salt, role, json.dumps(clean_overrides), active, timestamp, timestamp))
                        user_id = int(cursor.lastrowid)
                record_audit("users", "save", "success", actor=actor, details={"userId": user_id, "username": username, "role": role, "active": bool(active)}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "id": user_id})
            elif path == "/api/local/users/delete":
                session = self.require_permission("users.manage")
                if not session: return
                user_id = int(data.get("id") or 0)
                if user_id == int(session["user_id"]): raise ValueError("You cannot delete your own account")
                with db_connect() as db:
                    row = db.execute("SELECT username, role, active FROM users WHERE id=?", (user_id,)).fetchone()
                    if not row: raise ValueError("User not found")
                    if row["role"] == "admin" and bool(row["active"]) and int(db.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]) <= 1: raise ValueError("Debe existir al menos un administrador activo")
                    db.execute("DELETE FROM users WHERE id=?", (user_id,))
                record_audit("users", "delete", "success", actor=actor, details={"userId": user_id, "username": row["username"]}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True})
            elif path == "/api/local/users/revoke-sessions":
                session = self.require_permission("users.manage")
                if not session: return
                user_id = int(data.get("id") or 0)
                with db_connect() as db:
                    db.execute("UPDATE users SET session_version=session_version+1, updated_at=? WHERE id=?", (now_ts(), user_id))
                    db.execute("DELETE FROM web_sessions WHERE user_id=?", (user_id,))
                record_audit("users", "revoke-sessions", "success", actor=actor, details={"userId": user_id}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True})
            elif path == "/api/local/account/password":
                session = self.require_session(mutate=True)
                if not session: return
                current_password = str(data.get("currentPassword", "")); new_password = str(data.get("newPassword", ""))
                with db_connect() as db:
                    user = db.execute("SELECT * FROM users WHERE id=?", (int(session["user_id"]),)).fetchone()
                    if not user or not verify_password(current_password, user["password_salt"], user["password_hash"]): raise ValueError("Current password is incorrect")
                    salt, digest = password_digest(new_password)
                    db.execute("UPDATE users SET password_hash=?, password_salt=?, session_version=session_version+1, updated_at=? WHERE id=?", (digest, salt, now_ts(), int(session["user_id"])))
                    db.execute("DELETE FROM web_sessions WHERE user_id=?", (int(session["user_id"]),))
                record_audit("account", "password-change", "success", actor=actor, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "reauthenticate": True})
            elif path == "/api/local/account/logout-all":
                session = self.require_session(mutate=True)
                if not session: return
                with db_connect() as db:
                    db.execute("UPDATE users SET session_version=session_version+1, updated_at=? WHERE id=?", (now_ts(), int(session["user_id"])))
                    db.execute("DELETE FROM web_sessions WHERE user_id=?", (int(session["user_id"]),))
                record_audit("account", "logout-all", "success", actor=actor, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "reauthenticate": True})
            elif path == "/api/local/account/2fa/setup":
                session = self.require_session(mutate=True)
                if not session: return
                with db_connect() as db:
                    current_user = db.execute("SELECT totp_enabled FROM users WHERE id=?", (int(session["user_id"]),)).fetchone()
                    if current_user and current_user["totp_enabled"]: raise ValueError("Disable the current 2FA setup before configuring it again")
                    secret = base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")
                    db.execute("UPDATE users SET totp_secret=?, totp_enabled=0, updated_at=? WHERE id=?", (secret, now_ts(), int(session["user_id"])))
                issuer = quote("Player Panel", safe=""); account = quote(str(session["username"]), safe="")
                uri = f"otpauth://totp/{issuer}:{account}?secret={secret}&issuer={issuer}&digits=6&period=30"
                self.send_json(HTTPStatus.OK, {"success": True, "secret": secret, "uri": uri})
            elif path == "/api/local/account/2fa/confirm":
                session = self.require_session(mutate=True)
                if not session: return
                with db_connect() as db:
                    user = db.execute("SELECT * FROM users WHERE id=?", (int(session["user_id"]),)).fetchone()
                    if not user or not user["totp_secret"] or not verify_totp(user["totp_secret"], str(data.get("code", ""))): raise ValueError("Invalid code")
                    db.execute("UPDATE users SET totp_enabled=1, updated_at=? WHERE id=?", (now_ts(), int(session["user_id"])))
                record_audit("account", "2fa-enable", "success", actor=actor, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True})
            elif path == "/api/local/account/2fa/disable":
                session = self.require_session(mutate=True)
                if not session: return
                password = str(data.get("password", ""))
                with db_connect() as db:
                    user = db.execute("SELECT * FROM users WHERE id=?", (int(session["user_id"]),)).fetchone()
                    if not user or not verify_password(password, user["password_salt"], user["password_hash"]): raise ValueError("Incorrect password")
                    db.execute("UPDATE users SET totp_secret=NULL, totp_enabled=0, updated_at=? WHERE id=?", (now_ts(), int(session["user_id"])))
                record_audit("account", "2fa-disable", "success", actor=actor, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True})
            elif path == "/api/local/push/subscribe":
                session = self.require_session(mutate=True)
                if not session: return
                subscription = data.get("subscription") if isinstance(data.get("subscription"), dict) else data
                endpoint = str(subscription.get("endpoint") or "").strip()
                keys = subscription.get("keys") if isinstance(subscription.get("keys"), dict) else {}
                p256dh = str(keys.get("p256dh") or "").strip()
                auth = str(keys.get("auth") or "").strip()
                if not endpoint.startswith("https://") or len(endpoint) > 2048 or not p256dh or not auth:
                    raise ValueError("Invalid push subscription")
                device_name = str(data.get("deviceName") or "Device").strip()[:120] or "Device"
                events = normalize_push_events(data.get("eventTypes"))
                timestamp = now_ts()
                with db_connect() as db:
                    db.execute(
                        """INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, device_name, event_types_json, enabled, created_at, updated_at, vapid_key_id, repair_required, last_error)
                           VALUES(?,?,?,?,?,?,1,?,?,?,?,NULL)
                           ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth,
                           device_name=excluded.device_name, event_types_json=excluded.event_types_json, enabled=1,
                           vapid_key_id=excluded.vapid_key_id, repair_required=0, last_error=NULL, updated_at=excluded.updated_at""",
                        (int(session["user_id"]), endpoint, p256dh, auth, device_name, json.dumps(events), timestamp, timestamp, VAPID_PUBLIC_KEY_ID, 0),
                    )
                record_audit("push", "subscribe", "success", actor=actor, details={"device": device_name, "events": events}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "subscriptions": push_subscriptions_for_user(int(session["user_id"]))})
            elif path == "/api/local/push/unsubscribe":
                session = self.require_session(mutate=True)
                if not session: return
                endpoint = str(data.get("endpoint") or "").strip()
                subscription_id = int(data.get("id") or 0)
                with db_connect() as db:
                    if endpoint:
                        db.execute("DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?", (int(session["user_id"]), endpoint))
                    elif subscription_id:
                        db.execute("DELETE FROM push_subscriptions WHERE user_id=? AND id=?", (int(session["user_id"]), subscription_id))
                    else:
                        raise ValueError("No subscription was provided")
                record_audit("push", "unsubscribe", "success", actor=actor, details={"id": subscription_id}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "subscriptions": push_subscriptions_for_user(int(session["user_id"]))})
            elif path == "/api/local/push/settings":
                session = self.require_session(mutate=True)
                if not session: return
                subscription_id = int(data.get("id") or 0)
                events = normalize_push_events(data.get("eventTypes"))
                enabled = 1 if bool(data.get("enabled", True)) else 0
                with db_connect() as db:
                    cursor = db.execute("UPDATE push_subscriptions SET event_types_json=?, enabled=?, updated_at=? WHERE user_id=? AND id=?", (json.dumps(events), enabled, now_ts(), int(session["user_id"]), subscription_id))
                    if cursor.rowcount == 0: raise ValueError("Device not found")
                self.send_json(HTTPStatus.OK, {"success": True, "subscriptions": push_subscriptions_for_user(int(session["user_id"]))})
            elif path == "/api/local/push/test":
                session = self.require_session(mutate=True)
                if not session: return
                dispatcher = PUSH_DISPATCHER
                if dispatcher is None: raise ValueError("Web Push is unavailable")
                delay_seconds = min(max(int(data.get("delaySeconds") or 0), 0), 30)
                user_id = int(session["user_id"])
                def enqueue_test() -> None:
                    dispatcher.enqueue({
                        "id": f"test-{now_ts()}",
                        "type": "test",
                        "severity": "info",
                        "title": "Player Panel",
                        "message": "Background notifications are working correctly.",
                        "ts": now_ts(),
                        "targetUserId": user_id,
                    })
                if delay_seconds:
                    timer = threading.Timer(delay_seconds, enqueue_test)
                    timer.daemon = True
                    timer.start()
                    message = f"Test scheduled in {delay_seconds} seconds. Close the app and lock the device."
                else:
                    enqueue_test()
                    message = "Test notification sent"
                self.send_json(HTTPStatus.ACCEPTED, {"success": True, "message": message, "delaySeconds": delay_seconds})
            elif path == "/api/local/onboarding/complete":
                state_payload = complete_onboarding(str(data.get("mode", "later")))
                record_audit("system", "onboarding-complete", "success", actor=actor, details={"mode": data.get("mode", "later")}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "onboarding": state_payload})
            elif path == "/api/local/crafty/connections/save":
                connection = save_crafty_connection(data)
                test = discover_crafty_servers(connection["id"]) if bool(data.get("test", True)) else {}
                record_audit("system", "crafty-connection-save", "success", actor=actor, details={"connectionId": connection["id"], "name": connection["name"]}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {
                    "success": True,
                    "connection": connection,
                    "connections": list_crafty_connections_public(),
                    "discovery": test,
                    "servers": list_server_profiles_public(),
                })
            elif path == "/api/local/crafty/connections/delete":
                connection_id = int(data.get("id") or 0)
                delete_crafty_connection(connection_id)
                record_audit("system", "crafty-connection-delete", "success", actor=actor, details={"connectionId": connection_id}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "connections": list_crafty_connections_public()})
            elif path == "/api/local/crafty/connections/discover":
                connection_id = int(data.get("id") or 0)
                discovery = discover_crafty_servers(connection_id)
                record_audit("system", "crafty-discover", "success" if discovery["available"] else "error", actor=actor, details={"connectionId": connection_id, "status": discovery["status"], "count": discovery["count"]}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK if discovery["available"] else int(discovery["status"]), {"success": discovery["available"], "discovery": discovery})
            elif path == "/api/local/crafty/connections/import":
                connection_id = int(data.get("id") or 0)
                server_ids = data.get("serverIds")
                if not isinstance(server_ids, list):
                    raise ValueError("Select at least one server to import")
                result = import_crafty_servers(connection_id, server_ids)
                record_audit("system", "crafty-import", "success", actor=actor, details={"connectionId": connection_id, "imported": len(result["imported"]), "skipped": len(result["skipped"])}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, **result})
            elif path == "/api/local/crafty/action":
                action = str(data.get("action", "")).strip()
                status, response = crafty_action(action)
                ok = 200 <= int(status) < 300
                record_audit(
                    "crafty",
                    action,
                    "success" if ok else "error",
                    details={"response": response if isinstance(response, dict) else {}},
                    actor=actor, request_ip=self.client_ip(),
                )
                message_map = {
                    "start_server": "Start command sent",
                    "stop_server": "Stop command sent",
                    "restart_server": "Restart command sent",
                    "backup_server": "Backup requested",
                }
                if ok:
                    if action == "backup_server":
                        record_alert("backup_requested", "info", "Backup requested", "Crafty started processing to manual backup.")
                    elif action in {"start_server", "stop_server", "restart_server"}:
                        record_alert("server_action", "info", "Server action", message_map.get(action, "Action sent"))
                payload = {
                    "success": ok,
                    "action": action,
                    "message": message_map.get(action, "Action sent") if ok else (
                        response.get("error_data") or response.get("error") or "Crafty rejected the action"
                        if isinstance(response, dict) else "Crafty rejected the action"
                    ),
                    "crafty": crafty_status(),
                }
                self.send_json(HTTPStatus.OK if ok else status, payload)
            elif path == "/api/local/places/save":
                place = validate_place(data)
                place_id = int(data.get("id") or 0)
                timestamp = now_ts()
                with db_connect() as db:
                    if place_id:
                        cursor = db.execute(
                            "UPDATE places SET name=?, world=?, x=?, y=?, z=?, yaw=?, pitch=?, updated_at=? WHERE id=? AND server_id=?",
                            (place["name"], place["world"], place["x"], place["y"], place["z"], place["yaw"], place["pitch"], timestamp, place_id, current_server_id()),
                        )
                        if cursor.rowcount == 0:
                            raise ValueError("Location not found")
                    else:
                        cursor = db.execute(
                            "INSERT INTO places(server_id, name, world, x, y, z, yaw, pitch, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (current_server_id(), place["name"], place["world"], place["x"], place["y"], place["z"], place["yaw"], place["pitch"], timestamp, timestamp),
                        )
                        place_id = int(cursor.lastrowid)
                record_audit("places", "save", "success", actor=actor, details={"id": place_id, **place}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "id": place_id, "places": query_places()})
            elif path == "/api/local/places/delete":
                place_id = int(data.get("id") or 0)
                if place_id <= 0:
                    raise ValueError("Invalid location")
                with db_connect() as db:
                    row = db.execute("SELECT * FROM places WHERE id=? AND server_id=?", (place_id, current_server_id())).fetchone()
                    if not row:
                        raise ValueError("Location not found")
                    db.execute("DELETE FROM places WHERE id=? AND server_id=?", (place_id, current_server_id()))
                record_audit("places", "delete", "success", actor=actor, details=row_dict(row), request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "places": query_places()})
            elif path == "/api/local/bulk":
                self.handle_bulk(data)
            elif path == "/api/local/account/dashboard-layout":
                if not current:
                    raise ValueError("Session unavailable")
                layout = save_dashboard_layout(int(current["user_id"]), data)
                self.send_json(HTTPStatus.OK, {"success": True, "layout": layout})
            elif path == "/api/local/metrics/settings":
                settings = update_metric_settings(data)
                record_audit("metrics", "settings", "success", actor=self.actor_name(self.session()), details=settings, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "settings": settings})
            elif path == "/api/local/system/backup":
                result = create_system_backup(actor)
                record_audit("system", "backup", "success", actor=actor, details=result, request_ip=self.client_ip())
                self.send_json(HTTPStatus.CREATED, {"success": True, "backup": result, "backups": list_system_backups()})
            elif path == "/api/local/system/backups/delete":
                filename = safe_backup_name(str(data.get("name", "")))
                target = BACKUP_ROOT / filename
                if not target.is_file():
                    raise ValueError("Backup not found")
                target.unlink()
                record_audit("system", "backup-delete", "success", actor=actor, details={"name": filename}, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "backups": list_system_backups()})
            elif path == "/api/local/system/restore":
                if str(data.get("confirmation", "")) != "RESTORE":
                    raise ValueError("Type RESTORE to confirm")
                filename = safe_backup_name(str(data.get("name", "")))
                result = restore_system_backup(filename)
                record_audit("system", "restore", "success", actor=actor, details=result, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "restore": result, "message": "Restore completed. Sign in again if the session was replaced."})
            elif path == "/api/local/system/maintenance":
                result = run_system_maintenance()
                record_audit("system", "maintenance", "success", actor=actor, details=result, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "maintenance": result, "diagnostics": system_diagnostics()})
            elif path == "/api/local/system/connections":
                connections = update_connection_settings(data)
                connection_type = str(data.get("type", "")).strip().lower()
                plugin_test: dict[str, Any] = {}
                crafty_test: dict[str, Any] = {}
                if connection_type == "plugin":
                    started = time.monotonic()
                    status, body = upstream_request("GET", "/api/v1/health", quiet=True)
                    plugin_payload = parse_json_bytes(body)
                    plugin_test = {
                        "available": int(status) == 200,
                        "status": int(status),
                        "latencyMs": round((time.monotonic() - started) * 1000, 1),
                        "target": connection_url_metadata(server_profile_config()["plugin"].get("apiUrl", "")),
                        "data": plugin_payload,
                        "diagnostic": plugin_payload.get("diagnostic", {}) if isinstance(plugin_payload, dict) else {},
                    }
                elif connection_type == "crafty":
                    crafty_test = crafty_status()
                record_audit(
                    "system",
                    f"connection-{connection_type}",
                    "success",
                    actor=actor,
                    details={"type": connection_type, "enabled": bool(data.get("enabled", True))},
                    request_ip=self.client_ip(),
                )
                self.send_json(HTTPStatus.OK, {
                    "success": True,
                    "connections": connections,
                    "plugin": plugin_test,
                    "crafty": crafty_test,
                    "servers": list_server_profiles_public(),
                    "selectedServerId": current_server_id(),
                    "craftyConnections": list_crafty_connections_public(),
                })
            elif path == "/api/local/system/settings":
                settings = update_system_settings(data)
                record_audit("system", "settings", "success", actor=actor, details=settings, request_ip=self.client_ip())
                self.send_json(HTTPStatus.OK, {"success": True, "settings": settings})
            elif path == "/api/local/alerts/read":
                ids = data.get("ids", [])
                if ids == "all":
                    with db_connect() as db:
                        db.execute("UPDATE alerts SET is_read=1 WHERE server_id=?", (current_server_id(),))
                elif isinstance(ids, list):
                    cleaned = [int(value) for value in ids if str(value).isdigit()]
                    if cleaned:
                        placeholders = ",".join("?" for _ in cleaned)
                        with db_connect() as db:
                            db.execute(f"UPDATE alerts SET is_read=1 WHERE server_id=? AND id IN ({placeholders})", [current_server_id(), *cleaned])
                self.send_json(HTTPStatus.OK, {"success": True})
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"success": False, "error": "NOT_FOUND"})
        except sqlite3.IntegrityError:
            self.send_json(HTTPStatus.CONFLICT, {"success": False, "error": "DUPLICATE", "message": "A location with that name already exists"})
        except (ValueError, TypeError, sqlite3.Error) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"success": False, "error": "BAD_REQUEST", "message": str(exc)})
        except (OSError, tarfile.TarError, RuntimeError) as exc:
            logger.exception("System operation failed")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"success": False, "error": "SYSTEM_ERROR", "message": str(exc)})

    def handle_bulk(self, data: dict[str, Any]) -> None:
        action = str(data.get("action", "")).strip().lower()
        uuids = data.get("uuids", [])
        body = data.get("body", {})
        if action not in BULK_ACTIONS:
            raise ValueError("Bulk action not allowed")
        if not isinstance(uuids, list) or not uuids or len(uuids) > 100:
            raise ValueError("Select between 1 and 100 players")
        if not isinstance(body, dict):
            raise ValueError("Invalid parameters")
        valid_uuids = [str(uuid) for uuid in uuids if re.fullmatch(r"[0-9a-fA-F-]{36}", str(uuid))]
        if len(valid_uuids) != len(uuids):
            raise ValueError("The list contains invalid UUIDs")

        snapshot = MONITOR.snapshot_players()
        results = []
        raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
        for uuid in valid_uuids:
            status, response = upstream_request("POST", f"/api/v1/players/{uuid}/{action}", raw)
            ok = 200 <= int(status) < 300
            name = player_name(snapshot.get(uuid, {}))
            record_audit(
                "bulk",
                action,
                "success" if ok else "error",
                actor=self.actor_name(self.session()),
                player_uuid=uuid,
                player_name=name,
                details=body,
                request_ip=self.client_ip(),
            )
            results.append({"uuid": uuid, "name": name, "success": ok, "status": int(status), "response": parse_json_bytes(response)})
        success_count = sum(1 for result in results if result["success"])
        self.send_json(HTTPStatus.OK, {"success": success_count == len(results), "successCount": success_count, "total": len(results), "results": results})

    def audit_proxy_action(self, path: str, data: dict[str, Any], status: int) -> None:
        result = "success" if 200 <= int(status) < 300 else "error"
        match = re.fullmatch(r"/api/v1/players/([0-9a-fA-F-]{36})/([a-z-]+)", path)
        if match:
            uuid, action = match.groups()
            name = player_name(MONITOR.snapshot_players().get(uuid, {}))
            record_audit("player", action, result, actor=self.actor_name(self.session()), player_uuid=uuid, player_name=name, details=data, request_ip=self.client_ip())
        elif path == "/api/v1/whitelist/add":
            record_audit("whitelist", "add", result, actor=self.actor_name(self.session()), player_name=str(data.get("name", "")), details=data, request_ip=self.client_ip())
        elif path == "/api/v1/whitelist/update":
            record_audit("whitelist", "update_uuid", result, actor=self.actor_name(self.session()), player_uuid=str(data.get("newUuid", "")), player_name=str(data.get("name", "")), details={"oldUuid": data.get("oldUuid"), "newUuid": data.get("newUuid")}, request_ip=self.client_ip())
        elif path == "/api/v1/world/control":
            record_audit("world", "control", result, actor=self.actor_name(self.session()), details=data, request_ip=self.client_ip())

    def login(self) -> None:
        ip = self.client_ip()
        now = time.time()
        attempts = LOGIN_ATTEMPTS[ip]
        while attempts and attempts[0] < now - LOGIN_WINDOW_SECONDS:
            attempts.popleft()
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"success": False, "error": "RATE_LIMITED", "message": "Wait before trying again"})
            return
        try:
            data, _ = self.read_json(8192)
        except ValueError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"success": False, "error": "BAD_REQUEST", "message": str(exc)})
            return
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        otp = str(data.get("otp", ""))
        with db_connect() as db:
            user = db.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
            if not user or not user["active"]:
                attempts.append(now); time.sleep(0.2)
                self.send_json(HTTPStatus.UNAUTHORIZED, {"success": False, "error": "INVALID_LOGIN", "message": "Incorrect username or password"}); return
            if int(user["locked_until"] or 0) > now_ts():
                self.send_json(HTTPStatus.LOCKED, {"success": False, "error": "ACCOUNT_LOCKED", "message": "Account temporarily locked"}); return
            if not verify_password(password, user["password_salt"], user["password_hash"]):
                failed = int(user["failed_attempts"] or 0) + 1
                locked_until = now_ts() + USER_LOCK_SECONDS if failed >= USER_MAX_ATTEMPTS else 0
                db.execute("UPDATE users SET failed_attempts=?, locked_until=?, updated_at=? WHERE id=?", (0 if locked_until else failed, locked_until, now_ts(), int(user["id"])))
                attempts.append(now); time.sleep(0.25)
                self.send_json(HTTPStatus.UNAUTHORIZED, {"success": False, "error": "INVALID_LOGIN", "message": "Incorrect username or password"}); return
            if user["totp_enabled"] and not otp:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"success": False, "error": "MFA_REQUIRED", "message": "Enter the authentication code"}); return
            if user["totp_enabled"] and not verify_totp(str(user["totp_secret"] or ""), otp):
                attempts.append(now)
                self.send_json(HTTPStatus.UNAUTHORIZED, {"success": False, "error": "INVALID_OTP", "message": "Invalid authentication code"}); return
            db.execute("UPDATE users SET failed_attempts=0, locked_until=0, last_login=?, updated_at=? WHERE id=?", (now_ts(), now_ts(), int(user["id"])))
            user = db.execute("SELECT * FROM users WHERE id=?", (int(user["id"]),)).fetchone()
        LOGIN_ATTEMPTS.pop(ip, None)
        token, csrf = create_session(user, ip, self.headers.get("User-Agent", ""))
        payload = {"success": True, "csrf": csrf, "user": public_user(user), "connections": connection_flags_public(), "servers": list_server_profiles_public(), "selectedServerId": default_server_id(), "timeZone": system_settings().get("timezone", DEFAULT_TIMEZONE), "minecraftAuthMode": MINECRAFT_AUTH_MODE, "onboarding": onboarding_state()}
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", self.cookie_header("pp_session", token, max_age=SESSION_TTL))
        self.security_headers(); self.end_headers(); self.wfile.write(body)
        logger.info("Successful login for %s from %s", username, ip)


    @staticmethod
    def cookie_header(name: str, value: str, max_age: int) -> str:
        parts = [f"{name}={value}", "Path=/", "HttpOnly", "SameSite=Strict", f"Max-Age={max_age}"]
        if COOKIE_SECURE:
            parts.append("Secure")
        return "; ".join(parts)

    def send_image(self, body: bytes, content_type: str, cache_seconds: int = 3600) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", f"private, max-age={max(0, cache_seconds)}")
        self.end_headers()
        self.wfile.write(body)

    def serve_player_image(self, path: str) -> None:
        match = re.fullmatch(r"/media/player/([A-Za-z0-9_-]{1,64})\.png", path)
        if not match:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        identifier = match.group(1)
        url = f"https://minotar.net/avatar/{quote(identifier, safe='')}/96.png"
        data = cached_remote_png("players", identifier.lower(), [url])
        self.send_image(data if data is not None else fallback_svg(identifier, player=True), "image/png" if data is not None else "image/svg+xml", 86400 if data is not None else 600)

    def serve_item_image(self, path: str) -> None:
        match = re.fullmatch(r"/media/item/([A-Za-z0-9_:.-]{1,128})\.png", path)
        if not match:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        material = match.group(1).split(":")[-1].lower().replace("-", "_")
        if not re.fullmatch(r"[a-z0-9_]+", material):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        base = f"https://assets.mcasset.cloud/{quote(MINECRAFT_ASSET_VERSION, safe='.')}/assets/minecraft/textures"
        urls = [f"{base}/item/{material}.png", f"{base}/block/{material}.png"]
        data = cached_remote_png("items", f"{MINECRAFT_ASSET_VERSION}:{material}", urls)
        self.send_image(data if data is not None else fallback_svg(material), "image/png" if data is not None else "image/svg+xml", 604800 if data is not None else 3600)

    def serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            path = "/index.html"
        relative = Path(path.lstrip("/"))
        if any(part == ".." for part in relative.parts):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        target = (STATIC_ROOT / relative).resolve()
        try:
            target.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not target.is_file():
            target = STATIC_ROOT / "index.html"
        try:
            body = target.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if target.name == "manifest.webmanifest":
            content_type = "application/manifest+json; charset=utf-8"
        elif target.suffix in {".html", ".js", ".css", ".svg", ".json", ".webmanifest"}:
            content_type = (mimetypes.guess_type(str(target))[0] or "application/octet-stream") + "; charset=utf-8"
        else:
            content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        is_worker = target.name == "service-worker.js"
        is_shell = target.name in {"index.html", "manifest.webmanifest"}
        cache_control = "no-cache, no-store, must-revalidate" if is_worker or is_shell else "public, max-age=86400"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if is_worker:
            self.send_header("Service-Worker-Allowed", "/")
        self.security_headers(cache_control)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    init_db()
    load_connection_overrides()
    VAPID_PUBLIC_KEY = ensure_vapid_keys()
    VAPID_PUBLIC_KEY_ID = vapid_public_key_id(VAPID_PUBLIC_KEY)
    PUSH_DISPATCHER = PushDispatcher()
    PUSH_DISPATCHER.start()
    for profile in list_server_profiles_public():
        get_monitor(profile["id"])
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.daemon_threads = True
    logger.info("PlayerPanel Web %s listening on %s:%d; plugin_configured=%s; crafty_configured=%s", APP_VERSION, LISTEN_HOST, LISTEN_PORT, connection_settings_public()["plugin"]["configured"], connection_settings_public()["crafty"]["configured"])
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop_all_monitors()
        if PUSH_DISPATCHER is not None:
            PUSH_DISPATCHER.stop()
        server.server_close()
