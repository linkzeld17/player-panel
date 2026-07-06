# Changelog

All notable changes to this project are documented here.

## [1.0.0-beta.1] - 2026-07-06

### Added

- Full guided installer for existing or new Crafty deployments.
- Web-only installer with direct, Crafty-assisted, and configure-later workflows.
- Multi-server profiles and an Add Server onboarding wizard.
- Direct IP, hostname, Docker-network, and HTTPS endpoint presets.
- Player management, whitelist, moderation, teleport, world controls, metrics, alerts, sessions, and history.
- Optional BlueMap and squaremap integrations.
- Saved-location squaremap thumbnails.
- PWA and Web Push support.
- Dedicated `update-web.sh`, repair, validation, and access-mode tools.

### Security

- Encrypted stored integration secrets.
- Trusted-proxy CIDR restrictions for forwarded client IPs.
- Secure-cookie support for HTTPS deployments.
- Administrator password validation before container startup.

### Compatibility

- Minecraft Java 26.1.2.
- Player Panel Fabric 1.1.7.
- Fabric API 0.153.0 or later.
