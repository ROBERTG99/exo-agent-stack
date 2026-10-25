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

## 2026-10-25 · Shell approvals, third iteration: expansions

- **Decision:** an unquoted `{` or `}` makes a command not provably safe (brace expansion can build `../x` or `/etc/passwd` from a word that looks local), as does an unquoted `*`, `?` or `[` in a word with a path segment that starts with a dot (`.*` matches `..`), and `printf` with any leading option (`-v` assigns a shell variable). Quoted braces and globs are literal and stay allowed, as do plain patterns such as `src/*.ts`.
- **Evidence:** 188 cases in `tests/unit/shell-safety.test.ts`; found by the third automated security review of the same file.

## 2026-10-25 · Bridge transports (T-29)

- **Decision:** the bridge is a stateless MCP server: one `McpServer` and transport per HTTP request (`POST /mcp` only; GET and DELETE answer 405), so nothing is held between calls and a stackd or bridge restart loses no session. Every HTTP request is checked in this order before an MCP message is read: Host (loopback name on the bridge port), Origin (absent, or loopback on the bridge port), bearer token; the health probe needs no token but still checks Host. The bridge uses the API token only and has no way to obtain the dashboard token. stdio reads the token from `EXOS_LOCAL_TOKEN` or `<state dir>/local-token`, prints nothing to stdout except protocol messages, and reports errors on stderr without the token.
- **Why:** BUILD.md §4.6 and §15 (DNS-rebinding and CSRF defences, loopback only) and NFR-8 (limits).
- **Next:** the tools and the call limiter's use (`rate_limited`) are in T-30; `scripts/bundle.mjs bridge` also builds the stdio entry used by `.mcp.json`.

## 2026-10-25 · Bridge tools (T-30)

- **Decision:** the nine tools are registered from one set of zod shapes (`bridge/src/schemas.ts`); `bridge/schemas/tools.v1.json` is generated from them by `scripts/gen-bridge-schemas.ts` (Prettier ignores it) and a contract test fails when the file and the schemas differ. Every call passes the 60-a-minute limiter first. A result carries `structuredContent` and a one-line text written by the bridge from stack-written values; agent text appears only as `untrusted_text` inside the fence, after the fence markers inside it were removed and the text cut to 4,000 characters; the raw event, `data`, never leaves stackd. A thread reference resolves through stackd (`GET /api/v1/threads/resolve`) so a slug shared by two agents is `ambiguous_thread`. `exo_approve` first checks that the request belongs to the named thread, then asks stackd to decide it as the API actor, so dashboard-only tools stay with the dashboard. Event views now expose `request_id` (approval requests) and `tool_call_id` (questions and tool calls) as plain tokens, so the model can call `exo_approve` and `exo_answer` without guessing ids.
- **Beyond the spec's list:** three error codes, `already_decided`, `stack_unavailable` and `internal_error`, and optional `credit_state` and `banner` on start and send (§4.8: warn adds a banner to responses).
- **Why:** BUILD.md §4.6, §15.3 and NFR-8.

## 2026-10-25 · Bridge calls are scoped by agent id and thread id

- **Decision:** the bridge resolves a thread reference to both ids and sends those, never the slug, to the answer and approval routes; stackd's question lookup also filters on the agent, and `exo_approve` requires the request's agent and thread ids to equal the resolved ones. Found by the automated security review: a slug shared by two agents let a call aimed at one agent's thread act on the other's.
- **Evidence:** two integration cases create the same slug on two agents and check that neither tool touches the other agent's open request.

## 2026-10-25 · Doctor (T-31)

- **Decision:** `doctor/src/checks/` holds the 22 checks as pure functions of a `StackSnapshot` (packages/common), each returning `pass`, `warn`, `fail` or `skip` with the evidence and, if not a pass, the fix. Only `fail` makes `exos doctor` exit 1. A check that throws is a `fail`, never a pass. `doctor/src/collect.ts` reads the real stack into a snapshot and lists in `unavailable` the checks it had no facts for, which are skipped with the reason: nothing is guessed. Names, origins and file modes are collected; secret values never are.
- **Bands chosen where the spec says only "check":** D-16 warns above 60 s of meter lag or any turn started outside the stack and fails above 300 s; D-18 warns at 120 days (a stale table is a warning, as in §4.8); D-13 (no `claude`), D-14 (Mode B unsupported, which is the default here) and D-15 (Cursor hosts not yet recorded, V-15) warn; D-10 fails for a host outside `allowlists.yaml` and warns when a shared environment gives an agent hosts beyond its own list, which closes the gap recorded in docs/KNOWN_LIMITATIONS.md; D-17 also covers the dashboard token file; D-20 allows the optional `claude-review.yml` to hold a secret as a warning.
- **Why:** BUILD.md FR-13 and §15.4. The pure-function design is what lets the seeded dataset (25 faults, 10 clean) test the doctor without a running stack.
- **Collector assumptions:** a public MCP server on a short list of known read-only URLs (DeepWiki) counts as having `always_ask` write tools, since its definition cannot say; Mode A's mount is `worktree` because the launcher runs `claude` in the thread's worktree; Mode B is `unsupported` until substitution is verified (V-9).

## 2026-10-25 · Doctor and bridge only send the token to a local stackd; MCP write policy read from tool policies

- **Decision:** `isLocalServiceUrl` (packages/common) accepts http(s) URLs whose host is a loopback address or a single-label name such as the compose service `stackd`, and nothing else (no other IP, no dotted name, no userinfo). The bridge refuses to start with any other `EXOS_STACKD_URL`, and the doctor collector does not call stackd, and marks D-16 and D-22 unavailable, if the URL is not local; the API token is therefore never attached to a request that could leave the machine. The collector's reading of an MCP server's write-tool policy now requires the server to ask by default and no tool to be `always_allow`, except tools on a short per-server list of known read-only tools (Playwright's snapshot, screenshot, console and network reads); a missing default policy counts as permissive; a server on the DeepWiki read-only URL is `always_ask` by construction.
- **Why:** two findings of the automated security review of T-31 (the token could be sent to an address set by an environment variable; a per-tool `always_allow` on a write tool was invisible to D-11).
- **Evidence:** `tests/unit/common/local-url.test.ts` (17 cases), `tests/unit/doctor/collect.test.ts` (token not sent, service name accepted, five policy cases), `tests/unit/bridge/limits.test.ts` (the bridge refuses a non-local stackd).

## 2026-10-25 · Local service URLs: an allowlist, not "any name without dots"

- **Decision:** `isLocalServiceUrl` accepts loopback literals, `localhost` and an explicit list of names (default `stackd`, the compose service). A name without dots is no longer accepted by itself: a DNS search domain can resolve it to another machine, and the API token goes with the request. Found by the automated review of the previous change.
- **Evidence:** `tests/unit/common/local-url.test.ts` refuses `http://intranet:9812` and `http://stackd2:9812`.

## 2026-10-25 · Plugin and Cursor integration (T-32)

- **Decision:** the plugin is named `exos` and declares the bridge as the plugin MCP server `exos-bridge` (tools are `mcp__plugin_exos_exos-bridge__<tool>`), started with `node <stack_dir>/bridge/dist/stdio.js` and `EXOS_STATE_DIR`, both asked from the user as `directory` options, so it works when the plugin is loaded from a checkout and no token is written anywhere. Commands pre-approve only the read tools; the writes ask at each call (§7.3). `exo-approve` is `disable-model-invocation`, only the user runs it, and it says not to call `exo_approve` before the user has named the request and the decision in their own message. The delegator agent is granted exactly the eight tools other than `exo_approve`. Cursor uses `.cursor/mcp.json` with `Bearer ${env:EXOS_LOCAL_TOKEN}` and a rule with the same limits.
- **Why:** BUILD.md §7.4 and §15.3 ("the delegator never approves"). `make plugin-validate` is our own check (`scripts/validate-plugin.ts`) because Claude Code's `claude plugin validate` would run the binary beyond `--version` and `--help`, which this build never does; the validator checks the same rules that matter here (names, grants, front matter, options) and the maintainer can add Claude Code's `--strict` run.
- **Residual risk:** `${CLAUDE_PROJECT_DIR}` in the delegate command is substituted by Claude Code in command content as documented; the exact behaviour in a real session is the maintainer's check. The `directory` option type and `${user_config.*}` in MCP `args` were read from the documentation, not run.

## 2026-10-25 · Host mode: TypeScript control, units rendered from templates (T-33)

- **Decision:** `exos host up|down|status|render` (cli/src/commands/host.ts) starts, stops and inspects the native stack, and `scripts/host-up.sh` is a thin wrapper for `make host-up` and `make host-down`. Services start in dependency order (fake model and Exo simulator, or the built Exo binary when `vendor/exo/target/release/exo` or `EXOS_EXO_BIN` exists; then stackd; then the bridge), each as a detached process with its output in `<state dir>/logs`, a pid file in `<state dir>/run` (mode 0600), a health check, and an environment of a few system variables plus `EXOS_*` settings, so no API-key variable of the parent reaches a service. `up` is idempotent and starts only what is missing (which is how a crashed stackd is brought back); a busy port or a service that does not become healthy stops everything started in that run. The simulator is announced as such on every start. `render` fills the launchd and systemd templates for a given repository, state directory, node and workspace roots, refuses paths a unit file cannot hold safely, and prints the install commands without running them.
- **Why:** BUILD.md FR-10 (durability across crashes) and §16 (native run); KeepAlive and Restart=on-failure give the OS-level restart, and the same `up` logic gives it without a unit file. `ProtectSystem=full` instead of `strict` because stackd must write into the user's repositories (git worktree metadata).
- **Not verified:** the units were rendered and structure-checked, not loaded into launchd or systemd.

## 2026-10-25 · Shell approvals, third iteration: patterns and git config (security review of T-33)

- **Decision 1:** an unquoted `*`, `?` or `[` is accepted only as a path after an explicit `--`; before it (as a positional, an option or an option value) the command is dashboard-only, and `echo`, `printf`, `cd` and `find` take no unquoted pattern at all. The parser already marked such words; `check`, `gitIsSafe` and `findIsSafe` now receive the marks.
- **Decision 2:** git is vouched for only when it reads objects and refs: `log`, `show` and `rev-parse`, each with `--no-pager`, `-c core.fsmonitor=false` and the three signature programs set to `false` (`-c gpg.program=false -c gpg.x509.program=false -c gpg.ssh.program=false`) before the subcommand, and `log` and `show` also with `--no-ext-diff --no-textconv` before any `--`. `status`, `diff`, `ls-files`, `blame`, `shortlog` and `describe` go to the dashboard. `--show-signature` and abbreviations of every forbidden long option (`--ext`, `--out=`, `--no-i`) are refused, because git accepts any unambiguous prefix; a `--pretty=` or `--format=` value (or an abbreviation of either) must be a built-in format name, because a name the repository defines can stand for `format:%GG`, and the default format can come from its config too.
- **Decision 3:** the phrases of `EXOS_APPROVE_DASHBOARD_ONLY` now match as words at an end that is a word character (`ssh` is `ssh host` and `/usr/bin/ssh host`, not the `ssh` in `-c gpg.ssh.program=false`), because the required pins would otherwise trip the default `ssh` pattern on every git command.
- **Why:** the review found that `rg -n todo *` can expand to a file named `--pre=sh`; that `git status` runs `core.fsmonitor` from a `.git/config` an agent may have written; and, in later rounds, that signature checking (`log.showSignature`, `%G` formats, a repository-defined format name) runs `gpg.program` from the same file, and that the clean filters run by work-tree `status` and `diff` execute configured programs too. A `-c` on the command line outranks every config file, so requiring it makes the approved text itself the guarantee; commands whose config exposure cannot be closed by flags are not vouched for.
- **Evidence:** `tests/unit/shell-safety.test.ts` and `tests/unit/approvals.test.ts` (`pnpm exec vitest run --project unit tests/unit/shell-safety.test.ts tests/unit/approvals.test.ts`: 240 tests).
- **Cost:** agents that want bridge approval for git reads must write the longer form; a plain `git status` goes to the dashboard.

## 2026-10-25 · A turn whose reply was lost is adopted, not repeated (M3 review)

- **Decision:** before `thread.start` or `turn.send` asks Exo for a turn, stackd saves the newest `turn_started` id of the thread as `submit_after` in the idempotency progress. A retry with the same key that finds a newer turn there adopts it (finished or not) instead of submitting again; a retry that finds none submits, after the capacity check. The 409 adoption of a running turn stays.
- **Why:** the review reproduced a 503 after Exo had accepted the turn: the retry started a second turn with the same input (BUILD.md §4.9, never repeat a step). The key used to be freed whenever nothing was saved, and the turn step saved only after Exo answered.
- **Evidence:** `tests/integration/threads.test.ts`, "a turn whose reply was lost" (3 tests, with a fetch that drops the answer to the first turn request).
- **Residual risk:** it assumes nothing else starts a turn on the same thread between the two attempts; stackd is the only Exo writer for these threads and Exo answers 409 while a turn runs.
