# Known limitations

What is not done or not verified, and why. Updated as the build progresses; every entry names its cause and what would close it.

## Exo source not available (blocks verification against the pin)

- **What:** `vendor/exo` is not checked out. BUILD.md pins commit `f9f012730fd3bf7e061e3e947e01bd6c2bb415e9` but never names the repository URL. A web search found a candidate (`https://github.com/exoharness/exo`), but the permission classifier denied cloning it and the build did not use it without the maintainer's confirmation (see `PROGRESS.md`, "Needs the maintainer", and `docs/DECISIONS.md`).
- **Consequence:** V-1 to V-11, the real-Exo binary, `make exo-build`, `@real-exo` suites and recordings from a real Exo cannot be produced. Everything that depends on them is marked blocked in `PROGRESS.md`.
- **Closes when:** the maintainer confirms the URL; then T-02 and T-09 run and the simulator recordings below are replaced by real ones.

## Exo API fixtures are recorded from the simulator, not from Exo

- **What:** `fixtures/exo-recordings/exo-sim/` (34 recordings) and the six WireMock mappings generated from them come from `exo-sim` through `make record-exo-sim`, not from a real Exo. The request and response shapes are the ones `packages/exo-client` assumes, so a contract test passing means the client, the recordings and the simulator agree with each other, not with Exo. The agent object fields (`id`, `slug`, `name`, `harness`) stay an assumption; stackd only relies on `id` being a string.
- **Simulator behaviours worth knowing:** the fake model picks its scenario from the first user message of a conversation, so a second turn on a thread continues the first scenario (the recorder uses a fresh thread for each scenario); the simulator runs the scripted harness for every agent whatever harness the definition names.
- **Consequence:** WireMock-backed tests prove stackd's behaviour against this stand-in, not against Exo.
- **Closes when:** `make record-exo-fixtures` runs against a real Exo (`EXOS_EXO_URL`), `make test-exo` passes, and the shape differences it reports are resolved or recorded.

## WireMock container runs as root

- **What:** the upstream `wiremock/wiremock` image runs as root; our own images run as `1000:1000`.
- **Consequence:** it is a test double bound to `127.0.0.1:9841`, mounted read-only, with no secrets. Accepted for the default compose stack.

## Cloud build override untested

- **What:** `compose.cloud.yaml` (host-network builds for Claude Code on the web, Appendix A) is applied only when `CLAUDE_CODE_REMOTE=true`. This build ran locally on macOS, so the override has not been exercised.

## Containers listen on all interfaces inside their own network namespace

- **What:** BUILD.md §0.1 rail 3 says every listener binds `127.0.0.1`. Docker's port publishing cannot reach a service that listens only on the container's loopback, so the stackd and fake-model images listen on all interfaces *inside the container*. See `docs/adr/0009-container-listen-address.md`.
- **Consequence:** nothing is reachable from the LAN as long as compose publishes only `127.0.0.1:<port>` (tested statically in `tests/integration/skeleton.test.ts`; `tests/integration/loopback.test.ts` in T-47 checks the running stack). Host processes cannot use this exception: the code requires `EXOS_LISTEN_HOST=container`, `EXOS_IN_CONTAINER=1` and a container filesystem, and the guard hook blocks setting those by hand.

## Guard hook is a best-effort text check

- **What:** `.claude/hooks/guard.mjs` inspects command text; it is not a sandbox and cannot parse all of shell. Residual gaps are listed in `docs/DECISIONS.md` (guard hardening entries).
- **Consequence:** the deny list, the permission classifier, milestone reviews and `make security` are the authoritative controls.

## `packages/exo-client` response shapes are unverified

- **What:** the client follows the endpoint table of BUILD.md §4.2 (paths, request bodies, event names). Response bodies are validated only for the members the stack relies on (for example `agents[].id`, `turn` or `turn.id`, `active`, `events[].id`/`type`); the SSE framing (`id:`/`data:` with an `id` field in the JSON) and the event-list envelope (`{events}` or a bare array) are assumptions. V-1 (bearer token), V-10 (health probe) and V-11 (managed-agent body) are not implemented beyond an optional bearer token.
- **Consequence:** the 34 client tests prove behaviour against an in-process stub, not against Exo.
- **Closes when:** T-09 verifies each item against the pinned source and T-08 re-records fixtures from a real Exo.

## Fake model wire formats are the public shapes, not Exo's consumer

- **What:** `fake-model` implements the public OpenAI Responses, OpenAI chat-completions and Anthropic messages formats (non-streaming and a basic streaming form). Whether Exo's `runResponsesHarnessTurn` accepts exactly these Responses events (for example the event names and the `id`/`call_id` fields) is unverified.
- **Closes when:** T-17 runs the scripted harness against the fake model under the real Exo (`@real-exo` suite) or T-09 reads the consumer in the pinned source.

## Scripted harness: the Exo adapter (`harnesses/scripted/harness.ts`) is not written

- **What:** `harnesses/scripted/turn.ts` (the turn loop) and `ledger.ts` are done and tested (10 tests: exactly-once replay after a crash between steps and after execute-before-record, idempotent ledger, round-trip cap, tool errors surfaced to the model). The module Exo loads (`defineHarness({ nativeToolApprovals, reconcileUnresolvedToolCalls: true, runTurn, resumeTurn })`) is not written: it must read the durable conversation through Exo's `TurnContext`, and the documented member list (`request`, `tools`, `agentConfig`, `conversationConfig`, `authorizeTool`, `executeTool`, `executePendingTools`, `startSandboxProcess`, `stream.*`, `exoharness.current`) does not say how the history is obtained. Guessing would produce code that looks finished but cannot run.
- **Consequence:** the offline stack and offline durability evals use the loop through the Exo simulator (docs/DECISIONS.md, "exo-sim"); the `@real-exo` suites cannot run.
- **Closes when:** T-09 reads `TurnContext` in the pinned source (new verification item V-12); the adapter is then a thin mapping from the context to `TurnPorts`.

## Product tools are not yet wrapped in Exo's `defineTool`

- **What:** `tools/ask-user.ts`, `tools/run-checks.ts` and `tools/write-report.ts` implement the behaviour (strict schemas, 600 s process-group timeout, ANSI-free 4000 character summaries, versioned idempotent reports, 1 MB limit) with 34 unit tests, and export JSON-schema declarations. Exo loads tools by module path with `defineTool`, whose signature and the artifact-writing API behind `ArtifactStore` are unverified (new verification item V-13).
- **Closes when:** T-09 reads the tool-module contract in the pinned source; the wrapper is then a few lines per tool.

## Mode A: launcher done, Exo adapter and live behaviour not verified

- **What:** `harnesses/claude-host/` implements and tests (77 unit tests, including an end-to-end run against a fake `claude` that rejects unknown flags): the scrubbed child environment, the deny list and bypass-disabled settings, the path-guard hook, argument building checked against the recorded help, the stream-json parser with usage mapping, the approvals broker and MCP server, abort and `claude_not_found`. Not done: the `defineHarness` module that Exo loads (`harnesses/claude-host/harness.ts`, blocked on V-12 like the scripted harness) and saving the Claude session id as an artifact for `--resume`.
- **Not verified without the maintainer:** how the real binary behaves with the generated settings and `--permission-prompt-tool` (`make live-claude`), and whether the real stream matches the hand-written sample.
- **Residual risk (BUILD.md §15.5):** Mode A has no isolation beyond the worktree mount, the deny list, the path-guard hook and approvals; Bash is not path-restricted by the hook. Use Mode B for untrusted repositories.

## Worktrees: git filter drivers are disabled, so git-lfs files stay as pointers

- **What:** `stackd/src/worktrees.ts` creates a thread's worktree with every repository-configured filter driver (`filter.<name>.smudge|clean|process`) and `core.fsmonitor` neutralised, and with the repository's hooks switched off. A smudge filter is a command git runs on checkout, so an untrusted repository could otherwise run code on the host while its worktree is created (relevant to Mode B, which exists for untrusted repositories).
- **Consequence:** a repository that relies on git-lfs (or another filter) gets the raw stored content, for example LFS pointer files, in the agent's worktree. `git worktree add` also requires the repository's git directory, not only its working tree, to be inside `EXOS_ALLOWED_WORKSPACE_ROOTS`.
- **Closes when:** an explicit per-agent opt-in (`allow_filters`) is added if the maintainer needs LFS in delegated work.

## Mode B status: unsupported until verified

- **Status (for the README and doctor `D-14`):** `unsupported`. Mode A is the default and the only mode this build can show working.
- **Done:** the stack's side of the contract. `harnesses/claude-sandboxed/mode-b-env.ts` maps an Exo egress placeholder to `CLAUDE_CODE_OAUTH_TOKEN`, removes the API-key variable, sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and refuses anything that is not a placeholder (5 unit tests). `tests/integration/mode-b-header.test.ts` shows the fake model API receiving `Authorization: Bearer exo_egress_test` and no `x-api-key` from a stand-in for Claude Code. The credential scripts validate input, refuse API keys, send the secret on stdin only and check `exo`'s help before sending (39 tests). ADR 0003 records the decision.
- **Not done / unverified:** the `claude-code-harness.ts` module Exo loads (blocked on V-12 and V-2), Exo's binding of the vault credential to the sandbox variable (V-2), the egress proxy substituting `Authorization: Bearer` for a credential bound to that variable (V-9), SmolVM or Firecracker availability (none on macOS; `/dev/kvm` absent), and the exact flags of `exo vault secret create` (V-14). The real Claude Code binary's use of `CLAUDE_CODE_OAUTH_TOKEN` is only statically supported (the variable exists in the 2.1.212 binary).
- **If V-2 or V-9 fail:** `patches/0001-claude-oauth-credential.patch` with tests and `docs/upstream/claude-oauth-credential.md` (ADR 0003, decision 3). Nothing is sent upstream.

## Environments: the Cursor agent's allowed hosts are empty, and the host-only network test is not written

- **What:** `environments/allowlists.yaml` gives `reviewer-cursor` an empty host list, because its hosts must be read from the pinned `exoharness/typescript/cursor/sdk.ts` (verification item V-15), which is not available. Nothing is guessed. In a sandbox that agent has no network until the list is filled in. The environment format (`environments/*.yaml`) is this stack's own description; the `exo environment create|update` calls that apply it are unverified.
- **Not written:** the host-only test `tests/integration/exo/network-policy.test.ts` ("a sandbox for repo-builder-b that connects to example.org is refused"). It needs a real Exo and SmolVM, and writing its body without either would be guesswork.
- **Closes when:** T-09 reads the Cursor SDK hosts and the `exo environment` flags; the maintainer's host (with SmolVM) runs the network test.

## Agent sync: the request body for Exo is a best reading of the spec (V-11)

- **What:** `exos agents sync` creates agents with `POST /exo/agent/managed` and updates them with `PUT /exo/agent/{id}/definition` (BUILD.md §4.2). The spec says only that the body is "built from the parsed Markdown" (V-11). `managedAgentBody` sends `{slug, definition, instructions}` with the definition's relative paths made absolute, and is the only code that changes when V-11 is verified. Idempotence does not depend on that shape: a state file keeps the sha256 of each body and the agent id, and Exo's own agent list decides whether an agent still exists.
- **Tested against:** an in-process Exo double with the same endpoints (14 tests). Not tested against a real Exo.
- **Count:** the catalogue has seven agents (FR-2's "7 unchanged"). The generated `dual-review-cursor` fallback is synced as well, so a second run reports 8 unchanged, the seven catalogue names among them.

## Exo verification items and the fallback each one uses

None of V-1 to V-16 could be verified because the pinned source was not available (see
`docs/exo-verification.md`, which names where to look for each). The fallback in use:

- **V-1** (bearer token on `--serve`): the client sends one only if configured; loopback bind is the protection.
- **V-2** (custom harness without `model.credential`): Mode A declares none; Mode B's patch route (ADR 0003) if it fails.
- **V-3** (provider value `local_process`): used in `environments/*.yaml`; only stackd's translation would change.
- **V-4** (`fork --up-to` over HTTP): `exo_fork` with `at` returns `fork_at_unsupported`.
- **V-5** (snapshot trigger): snapshot markers are a fork plus a git tag.
- **V-6** (agent front matter shape): the linter implements BUILD.md §4.5 and rejects unknown keys.
- **V-7** (`messages.usage` for a custom harness): Mode A maps Claude's usage as documented in `docs/DECISIONS.md`.
- **V-8** (policy tool names): `claude.<Tool>` from one function, `toExoToolName`.
- **V-9** (bearer substitution): Mode B is `unsupported`.
- **V-10** (health probe): stackd lists agents, as BUILD.md §4.2 says.
- **V-11** (managed-agent body): `managedAgentBody`, one function.
- **V-12** (`TurnContext` and `defineHarness`): tested loops, placeholder harness modules.
- **V-13** (`defineTool` and the artifact API): tested tool behaviour, no wrappers.
- **V-14** (`exo vault secret create` flags): the scripts check `--help` first.
- **V-15** (Cursor SDK hosts): the `reviewer-cursor` allowlist is empty.
- **V-16** (`exo environment create|update`): this stack's own YAML, translated in one place.

## The Exo simulator is not Exo

`exo-sim` implements the endpoints and event shapes the client assumes, not the real server's. It runs the scripted harness for every agent whatever harness the definition names, uses a fixed price list for `cost_usd`, answers `null` for previews, does not enforce vaults or environments, and has no authentication. Passing against it proves the stack's behaviour, not compatibility with Exo; that needs the maintainer's real-Exo run (see "Needs the maintainer" in PROGRESS.md).

## Environment hosts: the snapshot gives a limited environment the union of all allowlists

- **What:** `environments/allowlists.yaml` lists hosts per agent, but an environment (for example `smolvm-default`) is shared and, as far as the spec says, Exo's limited networking is a property of the environment, not of the agent (unverified, V-15). `doctor/src/environments.ts` therefore reports a limited environment with the union of every agent's list. Doctor D-10 ("allowlists within `allowlists.yaml`") passes by construction on that data, and an agent with an empty list (`reviewer-cursor`) would share the union if it were run in the same sandbox.
- **Consequence:** D-10 catches a host that was added to an environment outside `allowlists.yaml`, not an agent that gets more hosts than its own list. Per-agent isolation needs one environment per allowlist.
- **Closes when:** the doctor task (T-31) compares each sandboxed agent's list with the environment it is created in and warns on a wider one, or Exo is verified to scope the policy per agent.

## stackd threads API: conventions Exo has not confirmed

- **What:** (1) `resources` in `POST /api/v1/threads` are checked against `EXOS_ALLOWED_WORKSPACE_ROOTS` and audited, but nothing mounts them, because the thread-create body in BUILD.md §4.2 has no field for them. (2) The harness is expected to find the worktree at `<state dir>/worktrees/<thread slug>`. (3) Thread status looks at the newest 200 events, so a request that has been open for longer than that window shows as not pending. (4) `EXOS_MAX_ACTIVE_TURNS` is not enforced yet (T-28).
- **Closes when:** the maintainer's Exo run shows how a harness receives a workspace and extra mounts (V-3, V-12); the supervisor in T-28 tracks active turns.

## Lineage reads the simulator's `thread_forked` shape

- **What:** `GET /api/v1/threads/{agent}/{thread}/lineage` finds a fork's parent and a thread's children from `forked_from` and `forked_at_event_id` on `thread_forked` events, and scans at most 200 threads of the agent. Exo's real event fields are unverified (V-4), so against a real Exo the endpoint may report no lineage.
- **Closes when:** the maintainer's Exo run records a `thread_forked` event (`make record-exo-fixtures`) and the field names are confirmed or adapted.

## Credit stop on a cold agent cache, and cancel-active not yet wired

- **What:** the 402 check before any Exo request needs the agent's pool, which stackd knows from the catalogue it last read. Right after a start, before any read, the first start request does one catalogue lookup in Exo before the credit check. `EXOS_CREDIT_CANCEL_ACTIVE` is parsed and reported by `/api/v1/credit` but nothing cancels active turns yet (T-28).
- **Closes when:** the supervisor (T-28) cancels active turns on a transition to `stop` and warms the directory at start-up.
