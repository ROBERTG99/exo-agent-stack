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

## 2026-10-25 · Guard hardening after the second automated security review

- **Decision:** `guard.mjs` now (a) blocks destructive pushes (`--delete`, `-d`, `--mirror`, `--prune`, `:ref` and `+ref` refspecs, combined short flags containing `f` or `d`), (b) recurses into `bash|sh|zsh -c`, `eval`, `$(...)`, backticks and `xargs`/`timeout` wrappers up to depth 3, and (c) checks `--bind`, `--host`, `--listen`, `--preview-domain` and docker `-p/--publish` values against a loopback allowlist instead of denying known-bad values; `-P/--publish-all` is blocked. `Bash(pnpm --filter:*)` and `Bash(pnpm exec tsx scripts/:*)` were removed from the allow list (every script already runs through a `make` target).
- **Kept:** `Bash(pnpm add:*)` and `Bash(pnpm install:*)`. pnpm 10 does not run dependency lifecycle scripts unless the package is listed in `onlyBuiltDependencies` (currently only `esbuild`), so the residual risk is the choice of package, which is reviewed in the lockfile diff.
- **Limits, stated honestly:** the guard is a best-effort text check, not a sandbox. The authoritative controls are the `deny` rules, the permission classifier and the reviewers; the guard catches the accidental case and the common indirections.
- **Reason:** second automated review (settings.json allow list, guard bypass via shell indirection, loopback denylist differential).

## 2026-10-25 · Guard hardening, round 3 (third automated review)

- **Decision:** git subcommand is found after global options (`-C`, `-c`, `--git-dir`, ...) with quotes stripped, falling back to a loose "push anywhere" reading only when the subcommand cannot be determined; docker publish checks parse short-flag bundles (`-dp`, `-itP`, `-p9800:9800`) and only apply to `run`/`create` (so `docker compose -p <project> up` is allowed); `$(...)`, `<(...)` and `>(...)` bodies are extracted with balanced, nested scanning; `xargs` and `timeout` option arguments are stripped before the command is inspected.
- **Heredocs and quotes:** the guard blocked its own author's commit because markdown backticks inside a heredoc looked like command substitution. Heredoc bodies are now removed before segment analysis (a quoted heredoc is literal data; an unquoted one only has its `$(...)` and backtick expansions inspected), and single-quoted text is masked before backtick extraction. Text-level checks (key literals, assignments, attribution trailers) still scan the complete command including heredoc bodies.
- **Not done, on purpose:** failing closed on unparseable input. Commit messages passed through heredocs routinely contain apostrophes and parentheses, so a "cannot parse, therefore block" rule would block ordinary commits. A full shell parser dependency was also rejected. The guard stays a best-effort text check; the `deny` rules, the permission classifier and the reviewers are the authoritative controls.

## 2026-10-25 · Guard hardening, rounds 4 and 5, and the stance on the guard

- **Round 4 (heredoc and quote parsing):** the regex heredoc splitter was replaced by a small lexer that tracks single and double quotes and `$(...)` frames. `<<` is only a heredoc outside quotes, never as `<<<`, and a body is removed only when its delimiter line is found (an unterminated heredoc stays in the text and is analysed). Git subcommand parsing treats unknown global options as uncertain and falls back to the loose "push anywhere" reading.
- **Round 5:** push flags use a safe-list (`-u`, `--tags`, `--dry-run`, `-o <opt>`, ...) because git accepts abbreviations such as `--forc`; any other dash flag, and any `+`/`:` refspec, is blocked. A lone `&` separates commands and leading `(`, `{`, `!`, `then`, `do`, `else` are stripped. Comments (`#` at word start) are copied through the lexer so `<<` inside a comment is not a heredoc. `--config-env` and `-c alias.*` mark the parse uncertain and any push-like argument then blocks. `GIT_CONFIG_*` assignments are blocked (they can override `user.*`). Compose files are parsed with the `yaml` package (long syntax needs `host_ip` 127.0.0.1 or ::1, `network_mode: host` is refused), with the regex kept for Edit fragments that are not valid YAML.
- **Stance:** `guard.mjs` is a best-effort check on command text, run before every Bash/Write/Edit. Text-level parsing of shell cannot be made complete, and each automated review round found another differential. The controls that do not depend on parsing are the `permissions.deny` list, the narrow allow list, the permission classifier, the milestone `reviewer` and `policy-guardian` passes, and the doctor/`make security` checks on the resulting files. Future parser differentials are fixed when cheap and recorded here rather than pursued without end; the guard must never be described as a sandbox.
- **Known residual gaps:** `${...}` expansions containing quotes, backslash-newline continuations inside heredoc openers, and aliases defined in git config files (not on the command line) are not modelled.

## 2026-10-25 · Container listen address (rail 3) and the `.env.example` allow/deny pair

- **Decision:** container images listen on all interfaces inside their own network namespace, guarded by `EXOS_LISTEN_HOST=container` + `EXOS_IN_CONTAINER=1` + a real container filesystem; compose publishes `127.0.0.1:` ports only. Full reasoning in `docs/adr/0009-container-listen-address.md`.
- **Alternatives:** host networking, a proxy, resolving the container address (see the ADR).
- **Reason:** Docker cannot forward to a container-local loopback listener; found by the M0 reviewer as an undocumented deviation from rail 3.
- **`Read(./.env.example)` allow vs `Read(./.env.*)` deny:** BUILD.md §7.1 mandates both entries and the deny wins, so the allow entry has no effect. Kept as specified; `.env.example` is read with `cat` through Bash when needed (it holds no credential).
- **Model usage logging:** the automated security reviews in this session come from a plugin hook, not from delegations by the build agent, so they are not in the "Model usage" table; only the build agent's own `opus` delegations are logged there.
