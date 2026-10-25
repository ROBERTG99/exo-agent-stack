# ADR 0003: Mode B uses a harness wrapper, with a Rust patch only as a fallback

- **Status:** proposed. The wrapper-side contract is implemented and tested; the Exo behaviour it
  relies on (V-2, V-9) is not verified yet, so doctor reports Mode B as `unsupported`.
- **Date:** 2026-10-25
- **Deciders:** build agent, per BUILD.md §0.2 and §7.2 (critical item: Mode B credential mapping)

## Context

Mode A (default) runs the unmodified `claude` binary on the host with the maintainer's login and no
Exo credential. Mode B runs Claude Code inside a SmolVM sandbox so that an untrusted repository
cannot reach the host, and keeps the long-lived credential outside the sandbox.

Exo's built-in `claude-code` harness expects an API key bound to `ANTHROPIC_API_KEY`; its egress
documentation covers API keys, not OAuth. This stack uses subscriptions only, so the credential is a
Claude setup-token (an OAuth token) stored in vault `personal` as `claude-oauth`, origin-bound to
`https://api.anthropic.com`.

## Decision

1. **Wrapper first.** A harness file named `claude-code-harness.ts`
   (`harnesses/claude-sandboxed/`) makes Exo bind the model credential to the sandbox variable
   `ANTHROPIC_API_KEY` as a placeholder (`exo_egress_<id>`). The wrapper (`mode-b-env.ts`) starts
   Claude Code with `CLAUDE_CODE_OAUTH_TOKEN` set to that placeholder, `ANTHROPIC_API_KEY` unset and
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. It forwards only what Exo's own harness forwards
   (`ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `TRACEPARENT`, `TRACESTATE`) plus a minimal base
   environment, and **refuses to pass on anything that is not an Exo egress placeholder**, so a real
   token can never reach Claude Code through this path.
2. **The egress proxy substitutes.** On requests to `https://api.anthropic.com` the proxy replaces
   `Authorization: Bearer exo_egress_<id>` with the real token. This is Exo's mechanism (verification
   item V-9: substitution in an ordinary header, for a credential bound to `ANTHROPIC_API_KEY`).
3. **Rust patch only if needed.** `patches/0001-claude-oauth-credential.patch` (with tests and a draft
   proposal in `docs/upstream/claude-oauth-credential.md`) is written only if V-2 or V-9 show that the
   wrapper cannot receive the placeholder or that the proxy does not substitute it. Nothing is sent
   upstream either way (rail 6).
4. **Fail safe.** If substitution cannot be verified, doctor check `D-14` reports Mode B
   `unsupported` and Mode A remains the default. Mode B is never silently degraded to a real token in
   the sandbox.

## Alternatives considered

- **Put the setup-token into the sandbox environment.** Simplest, but the sandbox, which exists to
  contain an untrusted repository, would hold a long-lived credential.
- **Patch Exo first.** Adds a maintained fork for something a wrapper may already achieve.
- **Use Exo's built-in claude-code harness with an API key.** Forbidden: no API keys (rail 1).

## Consequences

- The credential scripts (`scripts/mode-b-store-token.sh`) refuse API keys and send the token to
  `exo vault secret create` on stdin only; their `exo` flags are unverified (V-14) and the script
  checks the command's help before sending anything.
- The header contract is tested against the fake model server
  (`tests/integration/mode-b-header.test.ts`) with a stand-in for Claude Code; the real binary's
  behaviour inside SmolVM is a maintainer step.

## Evidence

- A static search of the installed Claude Code 2.1.212 binary (no execution) finds
  `CLAUDE_CODE_OAUTH_TOKEN` (61 occurrences), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (20) and
  `ANTHROPIC_BASE_URL` (40), so the variables this design relies on exist.
- `tests/unit/claude-sandboxed/mode-b-env.test.ts` (5 tests) and
  `tests/integration/mode-b-header.test.ts` (3 tests) pass.
