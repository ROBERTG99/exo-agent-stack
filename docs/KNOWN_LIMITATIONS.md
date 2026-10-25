# Known limitations

What is not done or not verified, and why. Updated as the build progresses; every entry names its cause and what would close it.

## Exo source not available (blocks verification against the pin)

- **What:** `vendor/exo` is not checked out. BUILD.md pins commit `f9f012730fd3bf7e061e3e947e01bd6c2bb415e9` but never names the repository URL. A web search found a candidate (`https://github.com/exoharness/exo`), but the permission classifier denied cloning it and the build did not use it without the maintainer's confirmation (see `PROGRESS.md`, "Needs the maintainer", and `docs/DECISIONS.md`).
- **Consequence:** V-1 to V-11, the real-Exo binary, `make exo-build`, `@real-exo` suites and recordings from a real Exo cannot be produced. Everything that depends on them is marked blocked in `PROGRESS.md`.
- **Closes when:** the maintainer confirms the URL; then T-02 and T-09 run and the placeholder fixtures below are replaced by recordings.

## Exo API fixtures are hand-written placeholders

- **What:** `deploy/wiremock/mappings/exo-agent-list.json` (and any other mapping added before T-08) is written from the spec's description of `GET /exo/agent`, not recorded from a real Exo. The agent object fields (`id`, `slug`, `name`, `harness`) are an assumption; stackd only relies on `id` being a string.
- **Consequence:** WireMock-backed tests prove stackd's behaviour against this stand-in, not against Exo.
- **Closes when:** `make record-exo-fixtures` runs against a real Exo (T-08).

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
