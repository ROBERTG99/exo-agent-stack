---
name: release
description: Prepares a release: changelog, version bump, verification, tag instructions. Never pushes tags itself.
---

# Release

1. Run `make verify` and `make verify-clean`; both must pass without API keys.
2. Update `CHANGELOG.md` (Conventional Commits since the last tag) and the version in `package.json`.
3. Commit as `chore(release): vX.Y.Z`.
4. Do not create or push tags: add "Push tag vX.Y.Z (triggers release.yml)" to "Needs the maintainer" in `PROGRESS.md`.
