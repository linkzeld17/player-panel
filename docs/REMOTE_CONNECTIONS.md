# Remote connections

Player Panel Web can run on a different machine from Minecraft and Crafty.

## Connection model

```text
Browser
  └─> Player Panel Web
       ├─> Player Panel Fabric API (required for player/world features)
       ├─> Crafty API (optional management layer)
       ├─> BlueMap (optional browser map)
       └─> squaremap (optional browser map and thumbnails)
```

## Direct IP and hostname formats

The UI accepts direct IPs, hostnames, or complete URLs.

### Fabric API

```text
192.168.1.50          → http://192.168.1.50:8765
192.168.1.50:8765     → http://192.168.1.50:8765
minecraft-host:8765   → http://minecraft-host:8765
https://plugin.example.com
```

### Crafty

```text
192.168.1.60          → https://192.168.1.60:8443
192.168.1.60:8443     → https://192.168.1.60:8443
crafty-host:8443      → https://crafty-host:8443
https://crafty.example.com
```

## Reverse proxy guidance

When a public domain proxies an internal service port, use the public HTTPS URL without the internal port.

Example:

```text
Public URL: https://plugin.example.com
Proxy target: http://192.168.1.50:8765
```

Do not use `https://plugin.example.com:8765` unless port 8765 itself is actually serving TLS and is publicly reachable.

## Crafty authentication

Use a dedicated Crafty API token whenever possible. Assign only the required servers and permissions to its user/role.

Test from the Player Panel host:

```bash
curl -v \
  -H 'Authorization: Bearer CRAFTY_API_TOKEN' \
  https://crafty.example.com/api/v2/servers
```

A JSON `200` response means the request reached Crafty and the token is accepted.

An HTML `403` response from a CDN/WAF means the request was blocked before reaching Crafty. Review the security event and allow the Player Panel server only for the required hostname and API path.

## Fabric API authentication

Test from the Player Panel host:

```bash
curl -v \
  -H 'Authorization: Bearer FABRIC_API_TOKEN' \
  https://plugin.example.com/api/v1/health
```

## TLS verification

Keep TLS verification enabled for valid public certificates. Disable it only for trusted private endpoints with self-signed certificates.

## Firewalls

Allow traffic only between the required hosts and ports. For remote deployments, the Player Panel host must be able to reach:

- Fabric API: usually TCP 8765 or HTTPS 443;
- Crafty: usually TCP 8443 or HTTPS 443;
- BlueMap/squaremap: their public HTTPS endpoints, when configured.
