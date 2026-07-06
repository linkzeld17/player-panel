# Troubleshooting

## The web container keeps restarting

```bash
docker logs --tail=200 player-panel-web
```

A common startup error is an administrator password shorter than 10 characters. Correct `/opt/player-panel/secrets/admin_password.txt`, set mode `0600`, and recreate the container.

## The installer appears stuck after starting the container

Check the container state:

```bash
docker ps -a --filter name=player-panel-web
```

Recent installers detect `restarting`, `exited`, and `dead` states and print the logs automatically.

## Browser cannot open port 8766

Check Docker publication:

```bash
docker ps --filter name=player-panel-web --format '{{.Ports}}'
```

For direct access, expect:

```text
0.0.0.0:8766->8080/tcp
```

Check the local firewall and the VPS/provider firewall.

## Plugin connection times out

From the Player Panel host:

```bash
curl -v \
  -H 'Authorization: Bearer FABRIC_API_TOKEN' \
  http://MINECRAFT_HOST:8765/api/v1/health
```

Verify routing, firewall rules, reverse proxy target, and token.

## Crafty returns 403

Inspect the response content:

- JSON from Crafty: review the token and role/server permissions.
- HTML from Cloudflare or another WAF: the request was blocked before reaching Crafty. Review the corresponding security event.

## Players are on the whitelist but cannot join

Look for `Failed to verify username` or `invalid session` in Minecraft logs. In online mode, authentication happens before whitelist evaluation. Use valid official sessions, or intentionally configure offline mode and understand its identity risks.

## BlueMap reports permission errors

The map directories must be writable by the user running Minecraft inside the Crafty container. Use `repair-server.sh` or verify ownership and permissions under the selected server directory.

## The PWA asks for login after every refresh

Verify the web URL and cookie mode. HTTPS deployments should use secure cookies. Direct HTTP deployments require `COOKIE_SECURE=false`. Avoid switching between IP, domain, HTTP, and HTTPS because cookies are origin-specific.

## Real client IP is not shown

When behind a reverse proxy, set `TRUST_PROXY=true` and restrict `TRUSTED_PROXY_CIDRS` to the actual proxy networks. Never trust forwarded headers from all Internet clients.
