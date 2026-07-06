# Release checklist

1. Update `VERSION`, component versions, `CHANGELOG.md`, and `release-manifest.json`.
2. Confirm no secrets, domains, private IPs, or installation databases are included.
3. Run:

   ```bash
   ./tests/test-package.sh
   python3 -m py_compile components/web/app/server.py
   node --check components/web/app/static/app.js
   ```

4. Regenerate `CHECKSUMS.sha256`.
5. Build release archives:

   ```bash
   ./scripts/package-release.sh
   ```

6. Verify all archives and checksums in `dist/`.
7. Create a signed Git tag:

   ```bash
   git tag -s v1.0.0-beta.1 -m 'Player Panel v1.0.0-beta.1'
   git push origin v1.0.0-beta.1
   ```

8. Upload the full and web-only ZIP files plus `SHA256SUMS` to the GitHub Release.
