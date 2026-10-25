# AGENTS.md

Essentials for any coding agent working in exo-agent-stack. The full guide is `CLAUDE.md`; the specification is `docs/specs/000-build-spec.md`.

- Stack: Exo (pinned submodule, read-only) + stackd (:9812) + bridge (:9811) + dashboard (:9800) + fake model (:9840). TypeScript on Node 22 with pnpm.
- Before committing run `make check-fast`; before declaring a task done run its area checks and record the command and result in `PROGRESS.md`.
- Test first. Offline first: no API keys, no network in tests. Never weaken a test to get green.
- Commits: Conventional Commits, explicit paths only, no Co-Authored-By, Claude-Session or "Generated with Claude Code" trailers, never touch git identity.
- Every listener binds 127.0.0.1 only; single owner; no shared vaults.
- Progress and decisions: `PROGRESS.md`, `docs/DECISIONS.md`, `docs/exo-verification.md`.

## Project rails (verbatim)

1. **No API keys.** Never store, request, generate, read or print `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` anywhere. The only model credentials are the maintainer's Claude Code login (Mode A), a setup-token (Mode B) and a Cursor user key, all created by the maintainer.
2. **The agent never signs in.** Never run `claude setup-token`, `claude login`, `/login`, `cursor-agent login`, `gh auth login` or `exo vault secret create|update` on a real vault; these are "Needs the maintainer" items (§1.5).
3. **Loopback only.** Every listener binds `127.0.0.1`; no `--auth-file`, `--multiplayer` or non-`localhost` `--preview-domain`; compose ports carry `127.0.0.1:`; no tunnels.
4. **No live subscription calls in CI or this build.** `make live-claude`, `make live-cursor` and `make eval-live` exit 2 when `CI=true` or `EXOS_LIVE_CONFIRM` is not `yes`; the agent never sets it.
5. **No real user state:** temp roots; never read `~/.exo`, `~/.claude`, `~/.cursor` or the keychain.
6. **Upstream read-only:** patches in `patches/`, proposals in `docs/upstream/`, nothing sent to Exo.
7. **Single owner:** no shared vaults, `use_sender_vault` or multi-user mode.
8. **Verify, never assume.** Use only the Exo surface in §4.2 or the pinned source. Check each **[verify]** item in `vendor/exo` and record item, file:line, result and consequence in `docs/exo-verification.md`; if unverifiable, take the fallback and record it in `docs/KNOWN_LIMITATIONS.md`.
