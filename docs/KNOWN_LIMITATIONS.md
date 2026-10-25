# Known limitations

What is not done or not verified, and why. Updated as the build progresses; every entry names its cause and what would close it.

## Exo source not available (blocks verification against the pin)

- **What:** `vendor/exo` is not checked out. BUILD.md pins commit `f9f012730fd3bf7e061e3e947e01bd6c2bb415e9` but never names the repository URL; the build did not guess one (see `PROGRESS.md`, "Needs the maintainer", and `docs/DECISIONS.md`).
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
