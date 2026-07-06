# Publishing to GitHub

This repository is ready to be published as a new GitHub project. Do not commit
runtime files, credentials, databases, backups, or installation reports.

## 1. Create an empty GitHub repository

Create a repository named `player-panel` without adding a generated README,
license, or `.gitignore`; those files already exist here.

## 2. Initialize and push the repository

Run these commands from the repository root:

```bash
git init
git add .
git commit -m "Initial public beta release"
git branch -M main
git remote add origin git@github.com:YOUR_ACCOUNT/player-panel.git
git push -u origin main
```

For HTTPS authentication, use this remote instead:

```bash
git remote add origin https://github.com/YOUR_ACCOUNT/player-panel.git
```

## 3. Verify GitHub Actions

Open the **Actions** tab and confirm that the `Validate` workflow passes. The
workflow checks shell, Python, and JavaScript syntax and runs the package tests.

## 4. Build release archives

```bash
chmod +x scripts/package-release.sh
./scripts/package-release.sh
```

Generated files:

```text
dist/player-panel-1.0.0-beta.1.zip
dist/player-panel-web-only-1.10.19.zip
dist/SHA256SUMS
```

## 5. Create and push the release tag

Use a signed tag when GPG signing is configured:

```bash
git tag -s v1.0.0-beta.1 -m "Player Panel v1.0.0-beta.1"
git push origin v1.0.0-beta.1
```

Otherwise, create an annotated tag:

```bash
git tag -a v1.0.0-beta.1 -m "Player Panel v1.0.0-beta.1"
git push origin v1.0.0-beta.1
```

## 6. Create the GitHub Release

Create a release from tag `v1.0.0-beta.1`, mark it as a pre-release, and upload:

- `player-panel-1.0.0-beta.1.zip`
- `player-panel-web-only-1.10.19.zip`
- `SHA256SUMS`

Use the corresponding entry from [CHANGELOG.md](../CHANGELOG.md) as the release
notes.

## 7. Recommended repository settings

- Enable branch protection for `main` after the first push.
- Require the `Validate` workflow before merging pull requests.
- Enable Dependabot alerts and secret scanning where available.
- Disable wiki and discussions unless they will be actively maintained.
- Add repository topics such as `minecraft`, `fabric`, `crafty-controller`,
  `bluemap`, `squaremap`, `docker`, and `self-hosted`.
