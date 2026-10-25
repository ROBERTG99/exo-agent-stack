# exo-agent-stack

A personal, self-hosted agent stack on Exo (pinned submodule `vendor/exo`, never edited): durable threads, sandboxes, vaults, policies and artifacts, running Claude Code and Cursor on the maintainer's own subscriptions, plus an MCP bridge for one-call delegation and a dashboard. TypeScript (Node 22, pnpm); Python only for the evalgate gate. This repository makes no model calls.

Source of truth: `docs/specs/000-build-spec.md` (`BUILD.md` until the final commit moves it). Progress: `PROGRESS.md`. Decisions: `docs/DECISIONS.md` and `docs/adr/`. Exo verification log: `docs/exo-verification.md`. Known gaps: `docs/KNOWN_LIMITATIONS.md`. After a compaction or restart, re-read the spec, `PROGRESS.md`, `docs/DECISIONS.md` and `git log --oneline -30`, then resume from the first unchecked task.

## Map (BUILD.md §4.1)

- `vendor/exo` Exo runtime, run as `exo --root "$EXOS_EXO_ROOT" run --serve --bind 127.0.0.1:9810`.
- `stackd/` (Fastify, :9812) is the only Exo writer: REST/SSE, credit guard, meter, approvals, worktrees, recovery supervisor, idempotency, audit chain, doctor API. State in SQLite (`stack.db`).
- `bridge/` (:9811, stdio and HTTP) maps nine MCP tools to stackd and wraps agent output as untrusted.
- `packages/exo-client/` typed `/exo` client. `doctor/`, `cli/` (`exos`), `dashboard/` (:9800), `fake-model/` (:9840), `data/generator/`.
- `harnesses/{claude-host,claude-sandboxed,scripted,local-shim}`, `tools/`, `agents/`, `environments/`, `plugin/`, `.cursor/`, `evals/`, `deploy/`.

## Commands

- `make bootstrap` installs tools and dependencies; `make check-fast` = lint + unit (< 60 s, run before every commit); `make test` adds integration and contract; `make typecheck`; `make lint`.
- `make up` / `make down` / `make seed` / `make demo` / `make e2e` / `make test-docker` / `make eval` / `make bench` / `make doctor` / `make verify`. `make help` lists all.
- Tests: Vitest projects `unit`, `integration`, `contract` (`pnpm exec vitest run --project unit`). Run the failing test first, then implement.
- Use the real binary `/opt/homebrew/bin/claude` (never the interactive shell wrapper); only `--version` and `--help` are ever run here.

## Conventions

- Test first; small verified increments; Conventional Commits; one commit per task with evidence in `PROGRESS.md`.
- Never skip, disable or weaken a test or threshold; fix the code or record the gap in `docs/KNOWN_LIMITATIONS.md`. Every number in docs comes from a command that was run.
- Offline first: tests, demo and `make verify` use the fake model and recorded Exo fixtures. No sleeps in tests (deadline polling), random ports, fixed seeds, temp roots.
- Synthetic data only, from `data/generator/` (seed `20261022`). Code, comments, commits and identifiers in English.
- Model calls: none in this repository. LLM rules for any future call are in `.claude/rules/llm-code.md` (BUILD.md Appendix B).
- Subagents and model routing: `.claude/rules/subagents.md`; log every `opus` and `fable` delegation in the "Model usage" table of `PROGRESS.md`.
- Hooks (`.claude/hooks/`) enforce the rails; do not work around a block, fix the cause.

## Commit attribution (BUILD.md §1.1)

Do not add Co-Authored-By, Claude-Session or "Generated with Claude Code" trailers to commits or pull requests. Do not modify `git config user.*` or the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables. Commit with explicit paths, never `git add .` or `-A`.

## Project rails (BUILD.md §0.1, verbatim)

1. **No API keys.** Never store, request, generate, read or print `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` anywhere. The only model credentials are the maintainer's Claude Code login (Mode A), a setup-token (Mode B) and a Cursor user key, all created by the maintainer.
2. **The agent never signs in.** Never run `claude setup-token`, `claude login`, `/login`, `cursor-agent login`, `gh auth login` or `exo vault secret create|update` on a real vault; these are "Needs the maintainer" items (§1.5).
3. **Loopback only.** Every listener binds `127.0.0.1`; no `--auth-file`, `--multiplayer` or non-`localhost` `--preview-domain`; compose ports carry `127.0.0.1:`; no tunnels.
4. **No live subscription calls in CI or this build.** `make live-claude`, `make live-cursor` and `make eval-live` exit 2 when `CI=true` or `EXOS_LIVE_CONFIRM` is not `yes`; the agent never sets it.
5. **No real user state:** temp roots; never read `~/.exo`, `~/.claude`, `~/.cursor` or the keychain.
6. **Upstream read-only:** patches in `patches/`, proposals in `docs/upstream/`, nothing sent to Exo.
7. **Single owner:** no shared vaults, `use_sender_vault` or multi-user mode.
8. **Verify, never assume.** Use only the Exo surface in §4.2 or the pinned source. Check each **[verify]** item in `vendor/exo` and record item, file:line, result and consequence in `docs/exo-verification.md`; if unverifiable, take the fallback and record it in `docs/KNOWN_LIMITATIONS.md`.
