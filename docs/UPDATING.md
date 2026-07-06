# Updating

## Update only Player Panel Web

This preserves users, sessions, secrets, server profiles, history, alerts, push subscriptions, and settings.

```bash
./update-web.sh --install-root /opt/player-panel --yes
```

The script:

1. backs up the current web application;
2. copies the new application files;
3. rebuilds the Docker image;
4. recreates the web container;
5. verifies `/healthz`;
6. restores the previous version if health verification fails.

## Update web and map bridges

When Crafty and the Minecraft server are local:

```bash
./update-web.sh \
  --install-root /opt/player-panel \
  --container crafty-controller \
  --server-id YOUR_SERVER_UUID \
  --yes
```

## Repair a complete installation

```bash
./repair-server.sh \
  --install-root /opt/player-panel \
  --container crafty-controller \
  --server-id YOUR_SERVER_UUID \
  --auth-mode keep \
  --yes
```

Stop Minecraft before using repair operations that modify server properties or player identity files.

## Verify after updating

```bash
curl -fsS http://127.0.0.1:8766/healthz

docker ps \
  --filter name=player-panel-web \
  --format 'Container: {{.Names}} | Status: {{.Status}} | Ports: {{.Ports}}'
```

Then refresh the browser. For a PWA, fully close and reopen the installed application if old assets remain cached.
