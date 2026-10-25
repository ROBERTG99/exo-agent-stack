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

## 2026-10-25 · better-sqlite3 runs from its shipped prebuilds; no compile in Docker

- **Decision:** `pnpm-workspace.yaml` no longer allows better-sqlite3 build scripts (`ignoredBuiltDependencies`). Version 13 ships `prebuilds/` for darwin and linux on arm64 and x64, so nothing is compiled locally or in the images.
- **Alternatives:** compile in a `node:22` (full) build stage; switch to the built-in `node:sqlite`; install a toolchain in `node:22-slim` (forbidden: no `apt-get`).
- **Evidence:** the 35 DB and CLI unit tests pass with the locally compiled `build/` directory moved away; the stackd image builds on `node:22-slim` aarch64.
- **Follow-up (T-23/T-47):** when stackd opens its database inside the image, the runtime stage must carry the `better-sqlite3` package directory (it is external to the bundle) and the migrations directory (`EXOS_MIGRATIONS_DIR`).

## 2026-10-25 · Mode A launcher: flags, hidden option, setting sources

- **`--permission-prompt-tool` is hidden from `claude --help` but supported.** `claude --help` (2.1.212, recorded in `fixtures/claude-help/claude-help.txt`) does not list it. A static search of the installed binary (`grep -a -c -- "permission-prompt-tool"` gives 14 hits, no execution) finds its handler and error messages, so the design of BUILD.md §4.7 stands. The flag is listed in `fixtures/claude-help/hidden-flags.txt` with that evidence; its live behaviour is confirmed by the maintainer with `make live-claude`.
- **Two flags beyond the spec's list, both present in `claude --help`:** `--strict-mcp-config` (the maintainer's global MCP servers do not load into an unattended run) and `--setting-sources local` (only the `settings.local.json` written for the turn supplies permission rules, so a user-level allow rule cannot bypass the approvals gate; authentication is unaffected).
- **Alternatives:** relying on `--permission-mode` alone (does not route prompts to Exo); leaving user and project settings active (a global `Bash(*)` allow would skip the gate).
- **Stream format:** `fixtures/claude-stream/sample.ndjson` is hand-written from the public description of stream-json, not recorded (the agent never makes a model call). The parser ignores unknown fields and types.
- **V-7 assumption:** `messages.usage.prompt_tokens` = uncached input + cache creation + cache reads; `cost_usd` = Claude Code's own `total_cost_usd` (an API-rate estimate).

## 2026-10-25 · Incident: a user-level hook corrupted the Mode A deny rule; policy dataset v1 regenerated

- **What happened:** the maintainer's global PreToolUse hook rewrites the `rm` command to `trash` in the whole text of a Bash command, heredoc bodies included. Files written through Bash heredocs that contained the deny rule `Bash(rm -rf:*)` therefore held `Bash( trash -rf:*)`: `harnesses/claude-host/settings.ts`, two of its tests, `data/generator/src/suites/policy.ts` and the generated policy datasets. The tests written the same way agreed with the corrupted value and passed. An automated review of the commit spotted it.
- **Fix:** the literal was restored with the Edit tool (which the hook does not touch); the deny list also gained the equivalent spellings `rm -fr` and `git push -f`; the settings test now reads the source bytes of the file and asserts the literal rule and the absence of `trash`; the generator tests compare every misconfiguration with the exact clean baseline (the old check compared with a clean variant and could not see a no-op mutation) and assert that only the "missing rule" case lacks the rule. `CLAUDE.md` now tells future sessions to write such files with Write or Edit and to grep for `trash` afterwards.
- **Dataset v1:** the D-12 "missing rule" mutation filtered on the corrupted name and changed nothing, so one policy case (pol-0019) was not a misconfiguration, and every stack carried the corrupted rule. `make seed` regenerated both policy files: `policy.v1.dev.jsonl` 9634b06aa8b6a697 to b31b558532560177 and `policy.v1.test.jsonl` e0845fa7a7ed6240 to 4435282948a03d4a (first 16 hex digits of sha256). This is an in-place correction rather than a `v2` because no eval, doctor check or report has consumed these datasets and nothing was tuned on them; it is recorded here so the change is auditable. From the first eval run on, test splits are immutable.
- **Other review fixes the same round:** the path-guard hook now rejects `..` in Glob patterns and Grep globs and checks the directory a glob starts in; `writeSettings` no longer follows a planted symlink (a non-directory `.claude` is unlinked, the file is written to a fresh temporary name and renamed into place).

## 2026-10-25 · Worktree creation runs git with repository configuration neutralised

- **Decision:** `git` runs with a fixed environment, `core.hooksPath=/dev/null` and `core.fsmonitor=false`; before `worktree add`, every `filter.<driver>` found in the repository config is overridden with a failing command and `required=false`. The repository's git directory and common directory must resolve inside the allowed roots, like its working tree.
- **Evidence:** two new tests fail without the fix (a configured smudge filter and a configured fsmonitor both ran during creation; a `--separate-git-dir` repository with its metadata outside the roots was accepted) and pass with it; the full worktree suite is 34 tests.
- **Alternatives:** trusting the repository config (single-owner argument: the maintainer's own repos), which fails for Mode B's untrusted-repository purpose; `git clone --no-local` into the state directory (copies history, loses the shared object store).
- **Reason:** automated review of the T-20 commit.

## 2026-10-25 · Worktree filter neutralisation, second iteration (final design)

- **Decision:** the worktree is created with `--no-checkout`; the filter drivers are then listed from inside the new worktree with `git config --null --get-regexp` (so conditional includes such as `includeIf onbranch` resolve as they will during checkout, and key and value are split unambiguously); every driver is overridden (`smudge`, `clean`, `process` = `false`, `required` = `false`) through the `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` environment variables, not `-c key=value`; files are then written with `git reset --hard`. Only "exit 1 with no stderr" means "no filters"; any other failure aborts creation and removes the half-made worktree. System git config is ignored (`GIT_CONFIG_NOSYSTEM` set to 1).
- **Why a second iteration:** the first fix (previous entry) was reviewed again and three bypasses were demonstrated by tests that failed first: a driver name containing an equals sign, a value ending in text that looked like another variable, and a filter that only a conditional include defines once the `exos/*` branch is checked out. A fail-open catch was also removed.
- **Evidence:** `pnpm exec vitest run --project unit tests/unit/worktrees.test.ts` runs 39 tests, including those three cases and a fail-closed case.

## 2026-10-25 · Local-model agent uses the local-shim harness path

- **Decision:** `agents/local-harness.md` names `../harnesses/local-shim/harness.ts`, the fallback allowed by BUILD.md §1.4 and §4.5, not `@agent-harness/exo-adapter`. The sibling repository (`~/dev/agent-harness`) has no built adapter package, so the preferred path does not resolve. The shim exports the tested turn loop and a chat-completions model client but deliberately no default export, so Exo refuses to load it until the adapter exists (V-12).
- **Model access:** `harnesses/local-shim/chat-model.ts` adapts the Responses-style conversation of `runScriptedTurn` to OpenAI-compatible chat completions and back, retries 429/5xx, and refuses any base URL that is not loopback. Offline the fake model stands in for Ollama (13 integration tests); the Ollama container belongs to the `local-model` compose profile (T-47).
- **Dual review:** `exos dual-review compare` reads two reviews (Markdown bullets as `write_report` saves them, or JSON lines) and writes `dual-review.comparison.v1`: findings per side, a one-to-one overlap by file and category within a line tolerance (default 3), what only one side found, and a Jaccard score. The two "recorded streams" in `fixtures/exo-recordings/dual-review/` are hand-written, labelled as such, and replaced by the maintainer's live run.

## 2026-10-25 · exo-sim: a stateful Exo double next to WireMock

- **Decision:** `exo-sim/` is a small Fastify and SQLite service that serves the §4.2 surface under `/exo` and runs every turn through the scripted harness against the fake model server. It is used by the default compose stack, the end-to-end tests and the durability suite. WireMock keeps serving the static recorded responses (T-08).
- **Why:** WireMock cannot serve a live event timeline, a pending approval that a later request resolves, or a turn that resumes after a kill. FR-10 and the approvals flow cannot be tested offline without that.
- **Durability model:** the event log is the source of truth. The conversation is rebuilt from it before every model call, a tool call is recorded before it runs and its result after, decisions are stored rows, and `recover()` re-runs turns still marked running. Tool calls are idempotent by `tool_call_id`, so a call whose result was lost adds no second ledger line.
- **Honesty:** shapes and semantics are the simulator's, not Exo's (V-6, V-11 and the rest of docs/exo-verification.md stay unverified). A tool error is returned to the model as an `{error}` result and the turn continues, as in the scripted harness.
- **Evidence:** 25 integration tests, one of which SIGKILLs the child process mid-turn and checks 12 unique ledger entries and 0 duplicates after restart.

## 2026-10-25 · Recordings come from exo-sim, with shape comparison for a host re-recording

- **Decision:** `scripts/record-exo.ts` records a fixed, strictly sequential scenario so that ids and event order are identical on every run; timestamps are fixed and the repository path is scrubbed. A recording is one request and its response; `shapes.json` reduces each response to key names and value types. Comparing a host re-recording to the committed one fails on a lost key or a changed type and only reports keys the real Exo adds. WireMock gets mappings only for the stateless GET recordings, generated from the recordings and checked for drift by a contract test; stateful flows (turns, approvals, events) are served by exo-sim, not WireMock.
- **Why:** BUILD.md asks that a host re-recording yields identical shapes. Without a real Exo the committed baseline is the simulator's, and the comparison is what turns the maintainer's first real run into a concrete list of differences instead of a rewrite.
- **Evidence:** the contract suite (10 tests) includes byte-for-byte reproduction from the simulator and negative shape tests; the skeleton test now requires the generated-from label instead of "placeholder".

## 2026-10-25 · M1 review fixes

- **Decision:** the SSE watcher resets its failure count when a dropped connection had delivered events, so only consecutive connections without progress count against the retry budget; exo-sim reads whole threads page by page (the conversation and forks were cut at 1000 events), writes related rows in one transaction (turn with its opening events, pending decision with its request event, turn status with `turn_ended`, artifact with `artifact_written`), and answers 400 for a malformed `limit` or `after`.
- **Why:** each was found by the M1 reviewer and reproduced; a kill between two related writes would have left a turn that blocks its thread or an approval nobody can see.
- **Evidence:** a failing test came first for each (client suite 35 tests; exo-sim suite 25 tests, with `tool_requested` and `tool_result` counted per call id after both crash tests). The environment-hosts finding is a modelling limit and is recorded in docs/KNOWN_LIMITATIONS.md.

## 2026-10-25 · stackd start flow and idempotency semantics (T-23)

- **Decision:** `POST /api/v1/threads` validates with zod (strict objects, unknown fields are 400), takes the key from the `Idempotency-Key` header or the body (not part of the hashed request), and runs: credit gate → agent lookup in Exo → worktree (if `workspace`) → Exo thread keyed by the slug `d-` + 10 hex of `sha256(key)` → first turn with `ask_user` as a frontend tool. Progress is saved in the idempotency row after each step, so a retry after a crash or a 503 resumes and never repeats a step; a retry whose first-turn submit hit 409 adopts the turn found in the event log. A run that failed before saving anything frees its key, so a corrected retry with a different body is not a 409. A replay answers 200, a first run 201.
- **Why:** BUILD.md §4.9 requires one thread and `replayed: true` for a repeated key and "never retry turn submission without a key"; freeing the key on early failure avoids a trap where a typo in the agent name burns the key.
- **Conventions fixed here:** the thread's worktree path is `<state dir>/worktrees/<thread slug>` so the harness can derive it from the slug (no Exo field for it is known); the environment and vault come from the agent's harness (Mode A and local: `host-a`; Mode B: `smolvm-default` and vault `personal`; Cursor: none), unverified against Exo (V-3); `resources` are validated against the allowed roots and recorded in the audit event but not mounted.

## 2026-10-25 · Event views: summaries are stack-written, agent text is `untrusted_text` (T-24)

- **Decision:** stackd serves every Exo event as a view `{id, type, ts, turn_id, session_id, summary, tool?, untrusted_text?, usage?, data}`. `summary` is built from the event type and identifiers that match `^[A-Za-z0-9_.:-]{1,64}$` only, so an agent cannot put a sentence in it by naming a tool, an artifact or a status; message text, tool output, error text and the `ask_user` question go to `untrusted_text`. `data` is the raw event and is untrusted. The bridge (T-30) passes `summary`, `tool` and `untrusted_text` (fenced) and drops `data`; the dashboard labels `untrusted_text` and `data`.
- **SSE relay:** `GET .../stream` follows Exo's watch through the client (reconnect with `after`, no repeated ids), honours `Last-Event-ID` over `?after=`, sends `: keep-alive` every 15 s, and on a failure sends one `event: stream_error` frame with a stable code before closing, so a browser can show a banner and reconnect with the last id. 404 and 401 are answered as problem+json before the stream starts. stackd closes open streams when it shuts down.
- **Why:** BUILD.md §15 (event text is untrusted, never used to choose an action) and FR-14 (new events within 1 s at p95).
- **Unverified:** the lineage endpoint reads `forked_from` and `forked_at_event_id` from `thread_forked` events, the shape exo-sim emits; Exo's real field names are not confirmed (docs/KNOWN_LIMITATIONS.md).

## 2026-10-25 · Meter and price table assumptions (T-25)

- **Decision:** `pricing/api-rates.v1.json` holds integer micro-dollars per million tokens for the four model ids the stack names (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), copied from the Anthropic pricing page on 2026-10-25, including Haiku 5.5's higher rates above 100,000 prompt tokens. Any other model id is priced at the highest rate in the table and marked `max_estimate`. Costs are rounded up with BigInt arithmetic. A positive `cost_usd` from Exo is trusted; zero or missing with tokens present is priced from the table, because an Exo harness that does not know a cost may report 0. Rows are keyed `<thread id>:<event id>` so equal event ids in two threads cannot hide usage.
- **Assumptions (V-7, unverified):** `prompt_tokens` excludes cached and cache-creation tokens (counting them separately can only overestimate), and `completion_reasoning_tokens` is part of `completion_tokens` and not billed again.
- **Why:** BUILD.md §4.8: an estimate must never undercount, and every number must come from a cited source.

## 2026-10-25 · Credit guard semantics (T-26)

- **Decision:** thresholds are decided in basis points with BigInt (`spent × 10000 ≥ budget × bp`), parsed from the environment as decimal text, so 14.00 of 20 is `warn` and 13.99 is not. The persisted state is the worse of the stored and the computed one inside a cycle, and is recomputed from the facts only when the budget changes (audited as `credit.budget_changed`). Every state change writes `credit.transition` to the audit chain and calls a hook (metrics, and cancelling active turns when `EXOS_CREDIT_CANCEL_ACTIVE=true`, from T-28).
- **402 before Exo:** routes check credit against the agent as last seen in an in-memory directory that the meter's regular passes and every catalogue read refresh, then check again after the lookup. A cold directory cannot know an agent's pool, so the first request after a start may reach Exo for the lookup (docs/KNOWN_LIMITATIONS.md). A refusal frees the idempotency key; a replay of a request that already started is not refused, because it spends nothing.
- **Security review fix:** the price lookup uses own keys only and a malformed event is priced at the highest rate, so one event cannot stop the metering pass.
- **Why:** BUILD.md §4.8 and FR-12.

## 2026-10-25 · Approvals queue and who may decide (T-27)

- **Decision:** the queue reads Exo's event log once per thread (cursor table `approval_cursors`, migration 0003) and keeps a row per request; it is refreshed when `/api/v1/approvals` is read and by the supervisor (T-28). A row closes when the log shows the answer, or the turn ended. Callers are told apart by credential: the local bearer token is `api` (bridge, CLI), the `exos_session` cookie from `GET /login?t=<token>` is `dashboard`; the cookie is an HMAC of the token, so it is not the token and changes with it. A request whose tool matches `EXOS_APPROVE_DASHBOARD_ONLY` is stored as `dashboard_only`, stays open, and only `dashboard` may decide it; the bridge gets 403 `dashboard_only` for approve and for deny, and nobody may approve it for the whole session (that would switch off the prompt for later calls). The default list is `git push`, `npm publish`, `curl`, `wget`, `ssh` inside `claude.Bash`, plus `claude.WebFetch` and `claude.WebSearch`; the command phrase is searched anywhere in the command, so a chained `... && git push` is caught and a false positive only costs a trip to the dashboard.
- **Failure handling:** a decision claims the row first, then calls Exo; if Exo cannot take it the row is put back so the decision can be retried; if Exo says the request is already answered or its turn is over the caller gets 409 and the next sync closes the row from the log. With an idempotency key the progress is saved after Exo accepted the answer, so a retry that lost only the reply returns the same result.
- **Why:** BUILD.md FR-11 and §15.3 (the delegator never approves; `git push`, `npm publish` and network tools are dashboard-only).
- **Unverified:** the event names and fields (`agent_runtime.approval_requested`, `approval_id`, `frontend_tool_requested`, `call_id`) are the simulator's; the tool names (`claude.Bash`) follow V-8.

## 2026-10-25 · Security review of T-27: a separate dashboard secret, and shell approvals that fail closed

- **Decision 1:** `GET /login?t=` now takes a second secret, `<state dir>/dashboard-token` (mode 0600), and only that. The API token (`local-token`, what the bridge and CLI present) can no longer mint a dashboard session, and the dashboard token is not accepted as a bearer. The session cookie is an HMAC of the dashboard token. So a process that holds only the API token cannot take decisions reserved for the dashboard. Both files sit in one state directory owned by one user, so this separates what each component is given, not what a same-user process can read; the deny rules keep agents out of the state directory, and doctor D-17 will check both modes and that the bridge's configuration names only `local-token`.
- **Decision 2:** a `claude.Bash` approval is dashboard-only unless the command is provably simple and local (`stackd/src/shell-safety.ts`): the command is parsed into words (no substitution, variables, subshells, here-documents, background jobs or odd quoting of the program name), every pipeline segment must be a program from a short list with safe arguments (reads, local git, `make` check targets, `pnpm test|lint|typecheck|build`, writers confined to relative paths), and redirects may only go to `/dev/null` or a relative path. The explicit `EXOS_APPROVE_DASHBOARD_ONLY` patterns still apply, and are now the only rule for tools other than Bash.
- **Why:** the first version searched the command text for `git push` and similar, which `git -c x=y push`, `/usr/bin/git  push` or `python -c` get past. 99 cases in `tests/unit/shell-safety.test.ts` cover the bypasses found and the commands that stay approvable.
- **Residual risk:** this is a limit on who may approve, in front of the deny rules and the path guard; it is not a sandbox, and a command the parser accepts still runs with the agent's permissions in its worktree.

## 2026-10-25 · Shell approvals, second iteration: read-only only

- **Decision:** the set of `claude.Bash` commands the bridge may approve shrinks to read-only inspection: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `sort`, `uniq`, `cut`, `tr`, `diff`, `echo`, `printf`, `date`, `basename`, `dirname`, `realpath`, `which`, `cd`, and `git status|diff|log|show|rev-parse|ls-files|blame|shortlog|describe`. Each has a list of allowed flags (a flag not on it makes the command unsafe, including bundled short options such as `sort -ofoo`), path arguments must be relative and free of `..`, `~` and variables, and redirects may only go to `/dev/null` or duplicate a descriptor. `make`, `pnpm`, `npm`, `git add|commit|checkout|reset|stash|tag`, `mkdir`, `touch`, `cp`, `mv` and every redirect to a file are dashboard-only.
- **Why:** the security review showed that any approvable writer defeats the gate, because a later approvable command (`make check-fast`, `pnpm test`, `git commit` with a hook) runs what was written; and that free-form paths let a bridge-approved `cat` print the dashboard token to the agent. A person decides anything that writes or runs code.
- **Evidence:** 170 cases in `tests/unit/shell-safety.test.ts` (the bypasses from three reviews, and the commands that stay approvable).
- **Residual risk:** a symlink inside a worktree that points outside it is invisible to a string check; the deny rules (`Read(~/.exo-agent-stack/**)`), the path guard and the dashboard token living outside the worktrees (a worktree can only name `..`, which is refused) are the defence. The dashboard token stays in the state directory next to the worktrees; moving it elsewhere is a hardening option recorded in docs/KNOWN_LIMITATIONS.md.

## 2026-10-25 · Recovery supervisor (T-28)

- **Decision:** the supervisor probes Exo with the agent-catalogue read (so the agent directory stays warm), and acts when Exo is seen after being down or unknown: once the grace period (default 5 s) has passed it looks at the newest turn of every thread. A turn that is active is followed (counted against the active-turn limit); one that is not active and never ended gets one continuation turn in the same session with a fixed prompt written by stackd; the table `recoveries` records the attempt and the continuation id (`continued:<turn>`), and the attempts of a chain are counted from the continuation links, so at most `EXOS_RECOVERY_MAX_ATTEMPTS` continuations follow one another before the thread shows `failed_recovery`. It also re-checks every 30 s, refreshes the approvals queue every 5 s, enforces `EXOS_MAX_ACTIVE_TURNS` for turns started through the stack (429 `rate_limited`), and cancels the active turns of a pool that reaches stop when `EXOS_CREDIT_CANCEL_ACTIVE=true`. Credit stop and a full turn limit postpone a continuation without using up an attempt; an attempt Exo never received is not counted.
- **Why:** BUILD.md §4.9 and FR-10 ("only Codex exports `resumeTurn`; the stackd supervisor continues Claude Code turns"). The idempotency key `recovery:<turn>` of the spec is realised by the `recoveries` row, since a repeated Exo submission cannot be deduplicated by Exo.
- **Evidence:** the end-to-end test kills the simulator mid-task and finishes it through the supervisor with each step run once.
- **Unverified:** that a real Exo reports a cut-off turn as inactive without a `turn_ended` after a restart (V-12), and that a continuation in the same session sees the earlier conversation.
