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

## 2026-10-25 · Exo repository URL is not in BUILD.md; T-02 blocked on maintainer confirmation

- **Decision:** do not clone `vendor/exo` until the maintainer confirms the URL. Continue with every task that does not need the Exo sources (M0 tooling, fake model, stackd store, generator, ...), build against the §4.2 surface as documented in the spec, and mark everything that needs the pin as blocked.
- **Alternatives:** (a) clone `https://github.com/exoharness/exo` anyway (found via web search; blocked by the permission classifier, and a wrong guess would pull untrusted code into the tree); (b) invent a `vendor/exo` stub (violates "never fake the missing part").
- **Reason:** BUILD.md §0.1 rail 8 and §20 (a): a required dependency is unreachable without a trusted source. The fallback in §1.3 covers a failed *build*, not an unknown *source*.

## 2026-10-25 · TypeScript pinned to 6.0.x, not 7.0

- **Decision:** `typescript@~6.0.3` for the whole workspace.
- **Alternatives:** TypeScript 7.0.2 (latest); running typescript-eslint against a side-by-side TS 6 install.
- **Reason:** `eslint` fails at startup with "typescript-eslint does not support TS 7.0" (typescript-eslint 8.72.0). Lint is a required gate (BUILD.md §12), so the latest version that every tool supports wins. Revisit when typescript-eslint supports TS >= 7.1.

## 2026-10-25 · Permission allow list uses bounded commands, not wildcard runners

- **Decision:** `.claude/settings.json` allows named `make` targets, named `pnpm exec <tool>` forms, `git push origin ...` and `docker compose <verb>`; it denies `Read(./.env)` and nested variants plus the three live make targets. No `node:*`, `pnpm:*`, `uv:*`, `make:*` or `git push:*`.
- **Alternatives:** broad wildcard entries (fewer prompts, but they allow arbitrary code execution through the allow list).
- **Reason:** the automated security review flagged the wildcard entries and the missing plain `.env` deny. The spec (§7.1) only requires the entries it lists; the extra convenience entries are ours to keep tight. Force pushes, identity changes and live targets are additionally blocked by `guard.mjs`.
