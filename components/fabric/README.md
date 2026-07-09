# Player Panel Fabric adapter source

This directory contains the Java source for `player-panel-1.1.7-fabric26.1.2.jar`, the Fabric-side adapter used by Player Panel.

The adapter exposes a small HTTP API from inside the Minecraft server. Player Panel Web consumes this API for player lists, whitelist management, teleport tools, inventory views, world controls, safe teleport position lookup, metrics and events.

## Requirements

- Java 25+
- Minecraft Java 26.1.2
- Fabric Loader 0.19.3+
- Fabric API 0.153.0+26.1.2 or newer
- Gradle with Fabric Loom

## Build

```bash
cd components/fabric
./gradlew build
```

If the Gradle wrapper is not present, use a local Gradle installation:

```bash
gradle build
```

The compiled mod will be generated under:

```text
components/fabric/build/libs/
```

## Runtime configuration

The mod reads:

```text
config/player-panel-fabric.properties
```

Default values are written automatically on first start.

Important settings:

```properties
api.enabled=true
api.bind-address=0.0.0.0
api.port=8765
api.require-token=true
api.token=CHANGE_ME
api.rate-limit.enabled=true
api.rate-limit.requests-per-minute=120
```

## Public beta note

This source tree is published with the public beta release so that forks can continue development independently.
