# Testing

## Package regression suite

```bash
chmod +x tests/*.sh tests/mock-docker
./tests/test-package.sh
```

The suite uses mock Docker commands for installer paths that should not modify the host.

## Syntax checks

```bash
bash -n install.sh install-panel-only.sh update-web.sh repair-server.sh \
  configure-web-access.sh validate.sh uninstall.sh
find scripts tests -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n
python3 -m py_compile components/web/app/server.py scripts/lib/crafty-server-discovery.py
node --check components/web/app/static/app.js
```

## Clean-system test

Use a disposable VM. Do not run destructive clean-install tests on a production Crafty host.

Recommended matrix:

- Ubuntu 22.04 amd64
- Ubuntu 24.04 amd64
- Ubuntu 24.04 arm64
- Docker already installed
- Docker absent
- Existing Crafty
- New Crafty
- Web-only `manual`, `crafty`, and `later` modes
