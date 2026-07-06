# Architecture

## Components

### Player Panel Web

- Python HTTP application in `components/web/app/server.py`.
- Static responsive UI/PWA in `components/web/app/static/`.
- SQLite persistence mounted under `/app/data`.
- Docker Compose deployment under `/opt/player-panel` by default.

### Player Panel Fabric

The Fabric mod exposes authenticated server-management endpoints for player, whitelist, world, metrics, and alert functions.

### Crafty integration

Crafty is optional. It provides discovery and server lifecycle/backup/log operations. Direct plugin connections work without Crafty.

### Map integrations

- BlueMap provides 3D map selection.
- squaremap provides lightweight 2D selection and saved-location thumbnails.
- Browser bridge files are installed into the corresponding map web assets.

## Data and secrets

Runtime files are kept outside the repository:

```text
/opt/player-panel/.env
/opt/player-panel/data/
/opt/player-panel/secrets/
/opt/player-panel/update-backups/
```

Do not commit these paths.

## Security boundaries

- Browser authentication protects the Player Panel UI.
- Fabric API Bearer tokens protect the Minecraft integration.
- Crafty API tokens protect optional Crafty operations.
- Reverse proxies terminate public TLS.
- Forwarded client-IP headers are accepted only from trusted proxy CIDRs.
