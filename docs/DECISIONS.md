# Decisions

Append-only log. Format: date, decision, alternatives, reason. Architectural choices also get an ADR in `docs/adr/`.

## 2026-10-25 · Repository layout follows BUILD.md, not the maintainer's personal playbook

- **Decision:** `PROGRESS.md` at the root, decisions in `docs/DECISIONS.md`, no `_meta/`, no `/retomar` command, no waiting for approval before each commit.
- **Alternatives:** `_meta/PROGRESS.md` and `_meta/DECISIONS.md` per the playbook bootstrap.
- **Reason:** the maintainer ran the session in "modo libre" and stated that BUILD.md's layout wins (BUILD.md §0.3).

## 2026-10-25 · Local run on the maintainer's Mac, existing remote

- **Decision:** work in `~/dev/exo-agent-stack` (local disk); `origin` is `git@github.com:ROBERTG99/exo-agent-stack.git` (public, created by the maintainer); push the current branch after each milestone.
- **Alternatives:** Google Drive copy (not used), a fresh clone.
- **Reason:** maintainer pre-flight; BUILD.md §1.2 and playbook rule against building on Drive.

## 2026-10-25 · `claude` binary path

- **Decision:** use `/opt/homebrew/bin/claude` (2.1.212) directly, never the interactive `claude` shell function (it wraps `claude-auto-retry` and needs a TTY).
- **Alternatives:** the shell function.
- **Reason:** `claude --version` through the function fails with "open terminal failed: not a terminal" in non-interactive shells. Only `--version` and `--help` are ever run by the build (BUILD.md §0.1).

## 2026-10-25 · Dependency versions are the latest at install time

- **Decision:** accept whatever `pnpm add` resolves as latest stable (for example vitest 5.0.5, typescript 7.0.2 at T-01) and lock it in `pnpm-lock.yaml`.
- **Alternatives:** pin older majors known from earlier training data.
- **Reason:** BUILD.md §5 "Versions: latest stable, locked"; registry output is authoritative over remembered versions.
