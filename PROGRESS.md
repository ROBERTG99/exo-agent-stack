# PROGRESS

Single source of progress for the build described in `BUILD.md` (copy: `docs/specs/000-build-spec.md`). After a compaction or restart: re-read `BUILD.md`, this file, `docs/DECISIONS.md` and `git log --oneline -30`, then resume from the first unchecked task.

## Needs the maintainer

Nothing here is done by the build agent (BUILD.md §0.1, §1.5). Items are added as the build discovers them.

- [ ] **Confirm the Exo repository URL for `vendor/exo` (blocks T-02, T-09 and everything verified against the pin).** BUILD.md pins commit `f9f012730fd3bf7e061e3e947e01bd6c2bb415e9` but never gives the URL. The build found `https://github.com/exoharness/exo` by web search (public, Rust, MIT, `git ls-remote` works) and tried `git submodule add`, which the permission classifier denied as untrusted code integration. Either allow it (add a `Bash(git submodule add:*)` permission rule or say "yes, use exoharness/exo") or give the correct URL. The test written first for T-02 is kept at `tests/pending/exo-pin.test.ts` (outside every Vitest project so it cannot turn the build red); move it to `tests/harness/` once the submodule is added.
- [ ] Sign in to Claude Code on this Mac (Mode A login).
- [ ] Run `claude setup-token`, then `scripts/mode-b-store-token.sh` (Mode B; the script stores the token in vault `personal` as `claude-oauth`).
- [ ] Create a Cursor user key and run `scripts/store-cursor-key.sh`.
- [ ] Create the Slack app for the `ops-slack` adapter and store its secrets in vault `ops-slack`.
- [ ] Run `make live-claude`, `make live-cursor` and `make eval-live` (needs `EXOS_LIVE_CONFIRM=yes`; never in CI).
- [ ] Review 10 policy eval cases and 5 traces (BUILD.md §11).
- [ ] Push release tags (the build never pushes tags).
- [ ] Approve Exo pin upgrades (`upgrade-exo-pin` skill prepares them).

## Commit attribution evidence (BUILD.md §1.1)

Local run, `GIT_AUTHOR_*` / `GIT_COMMITTER_*` unset; git config identity is used (never modified by the build).

`git var GIT_AUTHOR_IDENT` → `ROBERTG99 <54124633+ROBERTG99@users.noreply.github.com>`
`git var GIT_COMMITTER_IDENT` → `ROBERTG99 <54124633+ROBERTG99@users.noreply.github.com>`

`.claude/settings.json` and `.claude/rules/git-commits.md` were not pre-seeded; they were created in the first build commit. Output of `git log -1 --format='%an <%ae> | %cn <%ce>%n%B'` on that commit:

```text
ROBERTG99 <54124633+ROBERTG99@users.noreply.github.com> | ROBERTG99 <54124633+ROBERTG99@users.noreply.github.com>
chore: configure commit attribution
```

(Subject `chore: configure commit attribution`, no trailers.)

## Tasks

Status: `todo`, `doing`, `done`, `blocked`. Evidence is the command and a one-line result.

| ID | Title | Milestone | Status | Evidence |
|---|---|---|---|---|
| T-01 | Bootstrap and progress files | M0 | done | `pnpm vitest run tests/harness`: 9 passed (layout.test.ts) |
| T-02 | Exo submodule and build [FR-1] | M0 | blocked | `git submodule add https://github.com/exoharness/exo.git vendor/exo` denied by permission classifier (URL found by web search, not in BUILD.md); see Needs the maintainer |
| T-03 | Workspace, Makefile, env example | M0 | done | `make bootstrap && make check-fast`: lint clean, 90 unit/harness tests passed (make-targets: every §16 target defined, phony, `make -n` ok; env-example) ; `make typecheck` clean |
| T-04 | Claude Code harness files | M0 | done | `make check-fast`: 151 tests passed (claude-files.test.ts: 61 — rails and subagent rules verbatim from spec, 13 agents with routing-table models, 14 skills, settings, .mcp.json); markdownlint 43 files clean |
| T-05 | Hooks | M0 | done | `make check-fast`: 242 tests passed; hooks.test.ts covers guard (setup-token, key assignment/literal, 0.0.0.0, live target, trailer, force push, git identity, vendor/exo, immutable datasets) with allow-cases, stop loop, timeout, format, session-start dry run, registration. Settings hardened after two automated security reviews (bounded allow list, .env denies, guard recursion, destructive-push and loopback allowlist rules); 272 harness tests pass |
| T-06 | Walking skeleton | M0 | done | `make up`: wiremock, fake-model, stackd all healthy (19 s warm build); `make demo` lists 7 agents through stackd; unauthenticated 401, wrong Host 403, cross-site Origin 403; token mode 0600; `lsof` shows only 127.0.0.1 listeners; `pnpm exec vitest run --project integration`: 18 passed; `make check-fast`: 333 unit/harness tests passed; `make typecheck` clean; hadolint clean. Exo responses are a hand-written placeholder (docs/KNOWN_LIMITATIONS.md) |
| T-07 | exo-client [FR-8] | M1 | done | `pnpm exec vitest run --project unit packages/exo-client --coverage`: 34 passed, lines 98.6%, statements 96.0%, branches 88.4% (every §4.2 endpoint, retry policy, timeouts, error mapping, SSE resume, usage parsing); `make check-fast`: 490 passed; typecheck clean. Response shapes unverified against the pin (docs/KNOWN_LIMITATIONS.md) |
| T-08 | Recordings and contract tests [FR-8] | M1 | todo | |
| T-09 | Verification log [FR-1] | M1 | todo | |
| T-10 | Agent linter [FR-2] | M1 | todo | |
| T-11 | Agent definitions [FR-2] | M1 | todo | |
| T-12 | Environments [FR-3] | M1 | todo | |
| T-13 | Agents sync [FR-2] | M1 | todo | |
| T-14 | stackd store and audit | M1 | done | `make test`: 456 unit/harness + 24 integration passed; tests/unit/db (migrate: ordering, idempotency, checksum, rollback, gap/duplicate, every §4.4 constraint; audit-chain: genesis, linking, canonical hash, edited field/details, deleted event, forged link, truncation with checkpoint, two connections, rollback) and tests/unit/cli/audit-verify.test.ts run the real `exos audit verify` (exit 0 intact, 1 tampered, 2 no database); `make typecheck` clean |
| T-15 | Synthetic generator | M1 | done | `make seed` writes 18 files (5 suites x dev/test, manifest, fixtures); second run byte-identical (sha256 of all .jsonl compared) and `data/generator/src/cli.ts --check` ok; `pnpm exec vitest run --project unit tests/unit/generator.test.ts`: 36 passed (sizes 30/20/35/24/10 with the §11 splits, 25 misconfigurations over 17 checks + 10 clean stacks validated against StackSnapshot, credit gold labels equal an independent BigInt oracle incl. exact 70%/95% thresholds, no clock/unseeded randomness); `make check-fast`: 526 passed; typecheck clean |
| T-16 | Fake model [FR-10] | M2 | done | `pnpm exec vitest run --project unit tests/unit/fake-model`: 44 passed (Responses, chat and messages formats: scenario selection, deterministic replay by tool-result count, generated stepsN 1..200, streaming, 429/500/latency faults, header recording, strict scenario YAML); container check: `make up` healthy, POST /v1/responses with steps12 returns call_steps12_0, /__test/requests shows the Authorization header; `make check-fast`: 570 passed; typecheck clean. Wire formats follow the public OpenAI/Anthropic shapes; Exo's harness library use of them is unverified (docs/KNOWN_LIMITATIONS.md) |
| T-17 | Scripted harness [FR-10] | M2 | partial | Loop and ledger done: `pnpm exec vitest run --project unit tests/unit/harness`: 10 passed (12-step run, crash after step 6 and crash between execute and record both end with 12 unique ledger entries and 0 duplicates, no-op replay, round-trip cap, tool error surfaced). The Exo-facing `harness.ts` adapter is blocked on V-12 (TurnContext conversation access), see docs/KNOWN_LIMITATIONS.md |
| T-18 | Custom tools [FR-7] | M2 | partial | `pnpm exec vitest run --project unit tests/unit/tools`: 34 passed (ask_user limits 2000/6/no extra keys; write_report versions per call, idempotent by tool_call_id, 1 MB boundary by bytes; run_checks 600 s timeout kills the process group, ANSI stripped, last 4000 chars); `make check-fast` green. The `defineTool` wrappers and the Exo artifact store are blocked on V-13 (docs/KNOWN_LIMITATIONS.md) |
| T-19 | Mode A launcher and approvals [FR-4] | M2 | partial | `pnpm exec vitest run --project unit tests/unit/claude-host`: 77 passed (env scrub: API keys in the parent never reach the child; settings: deny list + bypass disabled + path guard incl. symlink and prefix-sibling escapes; args checked against recorded `claude --help` 2.1.212 + hidden-flag evidence; stream parser + usage; broker/MCP server fail closed; launcher end-to-end with a fake claude: approve/deny/throw, resume, 200 kB stdin prompt, crash, abort, no leftovers); `make check-fast` green, typecheck clean. Exo-facing `harness.ts` blocked on V-12; live behaviour is a maintainer step (docs/KNOWN_LIMITATIONS.md) |
| T-20 | Worktree manager [FR-4] | M2 | todo | |
| T-21 | Mode B wrapper and maintainer scripts [FR-5] | M2 | todo | |
| T-22 | Local model and dual review [FR-6] | M2 | todo | |
| T-23 | Threads and turns API [FR-8] | M3 | todo | |
| T-24 | Events and SSE relay [FR-14] | M3 | todo | |
| T-25 | Usage meter [FR-12] | M3 | todo | |
| T-26 | Credit guard [FR-12] | M3 | todo | |
| T-27 | Approvals queue [FR-11] | M3 | todo | |
| T-28 | Recovery supervisor [FR-10] | M3 | todo | |
| T-29 | Bridge transport [FR-8] | M3 | todo | |
| T-30 | Bridge tools [FR-8] | M3 | todo | |
| T-31 | Doctor [FR-13] | M3 | todo | |
| T-32 | Claude Code plugin and Cursor config [FR-9] | M3 | todo | |
| T-33 | Host units and CLI [FR-10] | M3 | todo | |
| T-34 | Dashboard scaffold [FR-14] | M4 | todo | |
| T-35 | Overview, Usage, Doctor [FR-14] | M4 | todo | |
| T-36 | Threads, timeline, lineage, artifacts [FR-14] | M4 | todo | |
| T-37 | Approvals screen [FR-11] | M4 | todo | |
| T-38 | E2E and accessibility [FR-14] | M4 | todo | |
| T-39 | Eval runner | M5 | todo | |
| T-40 | Durability suite [FR-10] | M5 | todo | |
| T-41 | Delegation suite [FR-8] | M5 | todo | |
| T-42 | Policy suite [FR-13] | M5 | todo | |
| T-43 | Credit suite [FR-12] | M5 | todo | |
| T-44 | Live guard and dual-review suite | M5 | todo | |
| T-45 | Telemetry | M6 | todo | |
| T-46 | Threat model and injection tests | M6 | todo | |
| T-47 | Images and compose | M7 | todo | |
| T-48 | Workflows | M7 | todo | |
| T-49 | Documentation and ADRs | M8 | todo | |
| T-50 | Demo | M8 | todo | |
| T-51 | Reviews and fixes | M9 | todo | |
| T-52 | Final verification | M9 | todo | |

## Global Definition of Done

- [ ] `make verify` passes from a fresh clone (§19) with no API keys set.
- [ ] `docker compose up -d --wait` brings every service to healthy; `make seed` and `make demo` run the scripted scenario end to end.
- [ ] `make test-docker` runs the full test suite inside containers and passes.
- [ ] Unit, integration, contract and E2E suites pass; line coverage is at least 85% on core packages and 70% overall.
- [ ] Offline evals meet every threshold in §11, and `evals/REPORT.md` is generated by script from the latest run.
- [ ] Lint, format and type checks are clean.
- [ ] Security scans report no high or critical findings, or each one is documented with a reason in `docs/security.md`.
- [ ] Every workflow in §17 exists and passes actionlint; if a GitHub remote exists and CI results can be observed, the pushed branch is green.
- [ ] Every screen in §13 is implemented with loading, empty, error and success states; axe reports no serious violations; Playwright captured the screenshots in `docs/images/`.
- [ ] The harness in §7 is complete: CLAUDE.md, AGENTS.md, settings, hooks with passing tests, rules, subagents, skills and `.mcp.json`.
- [ ] Every document in §18 exists, and every number in the README points to the command or report that produced it.
- [ ] The `reviewer` subagent's final verdict is "ship", and `security-review` findings are fixed or documented.
- [ ] `PROGRESS.md` has every task checked with evidence, and `docs/KNOWN_LIMITATIONS.md` lists what is not done.
- [ ] Every commit is authored and committed by the maintainer, and no commit message or pull request contains `Co-Authored-By`, `Claude-Session` or "Generated with Claude Code" (checked as in §19).
- [ ] `BUILD.md` lives at `docs/specs/000-build-spec.md`; all work is committed, and pushed when a remote exists.
- [ ] Every FR-1 to FR-14 has a passing named test and a task marked done.
- [ ] `make doctor` passes on the compose stack; `docs/exo-verification.md` covers V-1 to V-11.
- [ ] No API key, sign-in command, non-loopback bind or live CI call (`make security`, `tests/integration/loopback.test.ts`).
- [ ] NFR budgets pass in `make bench`; Mode B status is stated in README and `docs/KNOWN_LIMITATIONS.md`.
- [ ] Model usage log complete, and Fable invocations ≤ `BUILD_FABLE_BUDGET` (2).

## Model usage

Every `opus` and `fable` delegation is logged here (BUILD.md, Model routing). Main session: `sonnet`, effort `high`.

| Date | Task | Role | Model | Effort | Reason | Outcome |
|---|---|---|---|---|---|---|
| 2026-10-25 | M0 milestone | reviewer (general-purpose with `.claude/agents/reviewer.md`; the named agent is not loaded until the next session) | opus | high | milestone review (BUILD.md §0.9) | VERDICT fix first: 4 blockers (sign-in evasion via wrappers, env-var bind, undocumented rail 3 deviation, doc mismatches) fixed in the follow-up commits; notes handled or recorded |
| 2026-10-25 | M0 milestone | policy-guardian (general-purpose with `.claude/agents/policy-guardian.md`) | opus | high | milestone rail check | DECISION allow; 4 forward-looking notes (live-guard exit 2 in T-44, loopback test in T-47, unpinned `go install`, `.git/config` mtime) |
