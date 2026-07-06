# Contributing

Thank you for contributing to Player Panel.

## Ground rules

- Never include secrets, real `.env` files, SQLite databases, API tokens, passwords, private keys, backups, or unreviewed diagnostic bundles.
- Keep changes focused and document behavior changes.
- Preserve compatibility with `arm64` and `amd64` where practical.
- Do not rename the project, main folders, or release artifacts away from `player-panel`.

## Development checks

Before opening a pull request:

```bash
bash -n install.sh install-panel-only.sh update-web.sh repair-server.sh \
  configure-web-access.sh validate.sh uninstall.sh
python3 -m py_compile components/web/app/server.py
node --check components/web/app/static/app.js
./tests/test-package.sh
```

## Pull requests

Include:

- the problem being solved;
- the implementation approach;
- exact test commands and results;
- upgrade or migration notes;
- screenshots for UI changes, with private data removed.
