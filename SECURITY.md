# Security policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Use GitHub's private vulnerability reporting feature when enabled, or contact the repository maintainers privately.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not include real credentials or user data.

## Deployment guidance

- Publish Player Panel behind HTTPS for permanent Internet-facing deployments.
- Keep the Fabric API token private and rotate it if exposed.
- Use a dedicated Crafty API token with least privilege.
- Restrict trusted proxy CIDRs.
- Keep runtime secrets, SQLite data, and backups outside the repository.
- Review firewall rules and expose only required ports.

## Supported versions

Security fixes are provided for the newest beta/release line only unless a release notice states otherwise.
