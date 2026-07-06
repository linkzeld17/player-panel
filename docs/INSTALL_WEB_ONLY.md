# Web-only installation

This path installs only Player Panel Web. It does not install or modify Crafty, Minecraft, Fabric, the Player Panel mod, BlueMap, or squaremap.

Use it when:

- Crafty and Minecraft run on another server;
- you want to connect directly to the Fabric API;
- you want an empty panel and plan to configure servers later from the web UI.

## Install

```bash
chmod +x install-panel-only.sh update-web.sh scripts/lib/*.sh
sha256sum -c CHECKSUMS.sha256
./install-panel-only.sh
```

The installer asks which initial workflow to use:

### 1. Direct plugin connection

Connect Player Panel directly to the Fabric API. Crafty is not required.

You may enter:

```text
192.168.1.50
192.168.1.50:8765
minecraft-host:8765
https://plugin.example.com
```

Player Panel normalizes a bare IPv4 address to `http://IP:8765`.

### 2. Crafty-assisted setup

Save the Crafty endpoint and continue server discovery in the web UI. The Fabric API is still required for player-management features; Crafty only adds discovery and server-management operations.

### 3. Configure later

Installs Player Panel with zero server profiles. After login, the Add Server wizard opens automatically.

## Non-interactive examples

### Empty panel

```bash
PLAYER_PANEL_ADMIN_PASSWORD='replace-with-a-strong-password' \
./install-panel-only.sh \
  --setup-mode later \
  --non-interactive \
  --yes
```

### Direct plugin endpoint

```bash
PLAYER_PANEL_ADMIN_PASSWORD='replace-with-a-strong-password' \
./install-panel-only.sh \
  --setup-mode manual \
  --plugin-url https://plugin.example.com \
  --squaremap-url https://map.example.com \
  --squaremap-world minecraft:overworld \
  --non-interactive \
  --yes
```

### Crafty endpoint

```bash
PLAYER_PANEL_ADMIN_PASSWORD='replace-with-a-strong-password' \
./install-panel-only.sh \
  --setup-mode crafty \
  --crafty-url https://crafty.example.com \
  --non-interactive \
  --yes
```

## Password requirements

The initial administrator password must contain at least 10 characters. The installer validates this before starting Docker. In non-interactive mode, an invalid password causes an immediate error.

## Access

Default:

```text
http://SERVER_IP:8766
```

Verify:

```bash
curl -fsS http://127.0.0.1:8766/healthz
```

## Configure from the web UI

After login, open:

```text
System → Servers → Add Server
```

Choose:

- **Direct connection** for plugin URL/token and optional maps;
- **Import from Crafty** to register Crafty and discover servers.
