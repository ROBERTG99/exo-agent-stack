---
name: upgrade-exo-pin
description: Bumps the vendor/exo submodule and re-verifies V-1 to V-11, re-records fixtures and runs contract tests. Maintainer approves the pin change.
---

# Upgrade the Exo pin

1. Preparation only: this build never changes the pin without the maintainer ("approve Exo pin upgrades" in `PROGRESS.md`).
2. In a branch: `git -C vendor/exo fetch && git -C vendor/exo checkout <commit>`; stage only `vendor/exo`.
3. Re-verify V-1 to V-11 (spec §4.2) against the new source; update `docs/exo-verification.md` with file:line and results; record fallbacks in `docs/KNOWN_LIMITATIONS.md`.
4. `make exo-build`, then `make record-exo-fixtures` (host only) and diff the recordings: shapes must be identical or the client and contract tests change in the same commit.
5. Run `make test`, `make doctor` (D-01 must name old and new commits during the change) and the `@real-exo` suites. Ask `exo-integration-reviewer` for a verdict.
