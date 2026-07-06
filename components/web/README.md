# Player Panel Web 1.10.19

Web component for Player Panel. For a new full installation, use the interactive
`install.sh` script located at the root of the complete release package.

This component does not include passwords, tokens, domains, or server UUIDs.
Configuration is generated during installation.

## Client IP addresses behind a proxy

Set `TRUST_PROXY=true` and define `TRUSTED_PROXY_CIDRS` with the networks from
which the proxy reaches the container. The installer and `repair-server.sh`
generate these values automatically for `player-panel-net`.
