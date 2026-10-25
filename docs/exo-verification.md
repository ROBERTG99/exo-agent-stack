# Exo verification log

BUILD.md §0.1 rail 8: use only the Exo surface of §4.2 or the pinned source, and check every
**[verify]** item against `vendor/exo`, recording item, `file:line`, result and consequence here.

## Status of the pin

The pin is `f9f012730fd3bf7e061e3e947e01bd6c2bb415e9`. **`vendor/exo` is not checked out and the
pinned source was not available to this build**: BUILD.md does not name the repository, and cloning
a candidate found by web search was denied (task T-02, `PROGRESS.md` "Needs the maintainer"). So
no Exo item below could be verified, and none is marked verified. Each row names where to look, and
the fallback the code uses meanwhile; all fallbacks are also recorded in `docs/KNOWN_LIMITATIONS.md`.

When the submodule is added, work through the table top to bottom: change the status, put
`vendor/exo/<path>:<line>` in the evidence column, and adjust the one place named in the fallback
column. `tests/harness/verification-log.test.ts` refuses a "verified" row without a `file:line`.

## Items

| ID | Item | Where to look in the pinned source | Status | Evidence | Fallback in use (and the one place to change) |
|---|---|---|---|---|---|
| V-1 | `exo run --serve` accepts or requires a bearer token | `crates/cli/src/serve.rs` | unverified | none | `ExoClient` sends a bearer token only if configured (`bearerToken`); loopback bind plus doctor D-02 (no `--auth-file`) remain the protection |
| V-2 | A custom harness can run without `model.credential` (Mode A has no vault) | `crates/executor/src/managed_agents/config.rs`, `exoharness/examples/typescript/claude-code-harness.ts` | unverified | none | Mode A definitions declare no credential; if Exo requires one, Mode B's patch route in ADR 0003 applies and Mode A needs a placeholder |
| V-3 | The local-process provider's value is `local_process` | provider enum in the executor crate | unverified | none | `environments/*.yaml` use `local_process`; only the environment translation in stackd changes |
| V-4 | `exo thread fork --up-to EVENT_ID` is available over HTTP | `crates/managed-agents/src/http/protocol.rs` (fork) | unverified | none | `exo_fork` with `at` answers `fork_at_unsupported`; forks are taken at the thread head |
| V-5 | What triggers a sandbox snapshot (`sandbox_snapshotted` events) | `exoharness/docs/managed-agents.md`, executor snapshot code | unverified | none | Snapshot markers in the lineage view are a fork plus a git tag on the thread's branch |
| V-6 | The agent-definition front matter shape (fields, `adapters`, `mcp_servers`) | `website/docs-src/agent-definition.md` | unverified | none | `doctor/src/agent-schema.ts` implements the field set shown in BUILD.md §4.5 and rejects unknown keys |
| V-7 | How a custom harness fills `messages.usage` | `exoharness/examples/typescript/claude-code-harness.ts` | unverified | none | Mode A maps Claude's own usage to the documented fields (`stream.ts`, `toExoUsage`) with `prompt_tokens` as the whole prompt; the meter prices by tokens when `cost_usd` is absent |
| V-8 | Policy tool names for Claude Code tools (`claude.Bash`) | policy docs in `exoharness/docs/` | unverified | none | `toExoToolName` in `harnesses/claude-host/approvals.ts` is the only place that builds the name |
| V-9 | `Authorization: Bearer` substitution for a credential bound to `ANTHROPIC_API_KEY` | `docs/egress.md` and the egress proxy code | unverified | none | Doctor `D-14` reports Mode B `unsupported`; Mode A stays default (ADR 0003) |
| V-10 | The serve health probe is `GET /exo/agent` | `crates/cli/src/serve.rs` | unverified | none | stackd's health check lists agents (`GET /exo/agent`) as BUILD.md §4.2 says |
| V-11 | The managed-agent create and update body | `crates/managed-agents/src/http/client.rs`, `protocol.rs` | unverified | none | `managedAgentBody` in `cli/src/commands/agents-sync.ts` sends `{slug, definition, instructions}` |
| V-12 | How `TurnContext` exposes the durable conversation, and the exact `defineHarness` module shape | `exoharness/docs/managed-agents.md`, `@exo/harness` | unverified | none | The turn loop (`harnesses/scripted/turn.ts`) is tested; the Exo-facing modules (`harness.ts` files) are placeholders without a default export |
| V-13 | The `defineTool` signature and the artifact-writing API behind `ArtifactStore` | `exoharness/docs/`, `exoharness/examples/typescript/` | unverified | none | `tools/*.ts` export tested behaviour and JSON-schema declarations; the wrappers are not written |
| V-14 | The flags of `exo vault secret create` (for example `--origin`) | `crates/cli/src` vault commands | unverified | none | `scripts/lib/vault-store.sh` reads the command's `--help` first and aborts before sending a secret if `--origin` is absent |
| V-15 | The Cursor SDK hosts the sandbox must reach | `exoharness/typescript/cursor/sdk.ts` | unverified | none | `environments/allowlists.yaml` lists no hosts for `reviewer-cursor`; `scripts/store-cursor-key.sh` requires `EXOS_CURSOR_ORIGIN` |
| V-16 | The format and flags of `exo environment create` and `exo environment update` | `crates/cli/src` environment commands | unverified | none | `environments/*.yaml` is this stack's own format, translated by stackd in one place (T-33) |

## Claude Code facts checked locally

These concern the `claude` binary, not Exo. Nothing was executed beyond `--version` and `--help`
(the agent never signs in and never makes a model call); the rest is a static search of the installed
file. Version: `2.1.212 (Claude Code)`, `/opt/homebrew/bin/claude`.

| Fact | Command | Result |
|---|---|---|
| Headless flags used by Mode A are listed in `--help` | `claude --help` (recorded in `fixtures/claude-help/claude-help.txt`) | `-p`, `--output-format`, `--verbose`, `--model`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `--resume` listed |
| `--permission-prompt-tool` exists but is hidden from `--help` | `grep -a -c -- "permission-prompt-tool" /opt/homebrew/Caskroom/claude-code/2.1.212/claude` | 14 matches, including the messages "not found" and "must be an MCP tool" (`fixtures/claude-help/hidden-flags.txt`) |
| `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `ANTHROPIC_BASE_URL` are read by the binary | `grep -a -c -- "<NAME>" <same file>` | 61, 20 and 40 matches |
| `disableBypassPermissionsMode` is a recognised settings key | `grep -a -c -- "disableBypassPermissionsMode" <same file>` | 7 matches |

What these facts do not show is the behaviour of the real binary with the generated settings or
inside a Mode B sandbox. Those are the maintainer's `make live-claude` steps.

## Client integration facts checked against public documentation

These concern Claude Code and Cursor, not Exo. They were read from the public documentation pages
on 2026-10-25 (fetched as Markdown with `curl -H 'Accept: text/markdown'`), not by running either
client; the stack never runs `claude plugin validate` or signs in.

| Fact | Source page | Result |
|---|---|---|
| A plugin has `.claude-plugin/plugin.json` (only `name` is required), and `commands/`, `agents/` and `.mcp.json` at the plugin root | code.claude.com/docs/en/plugins-reference | confirmed; an unknown top-level key is stripped with a validator warning |
| A plugin's MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`, so `exo_approve` of this plugin is `mcp__plugin_exos_exos-bridge__exo_approve` | code.claude.com/docs/en/mcp (plugin-bundled servers) | confirmed |
| `${user_config.KEY}` is substituted in an MCP server's `command`, `args` and `env`; a `directory` option type exists | code.claude.com/docs/en/plugins-reference (User configuration) | confirmed |
| A plugin's agents honour `tools` and `disallowedTools` but not `mcpServers`, `hooks` or `permissionMode` | code.claude.com/docs/en/plugins/components (agents) | confirmed |
| A command's front matter takes `description`, `argument-hint`, `allowed-tools` and `disable-model-invocation`; `$ARGUMENTS` carries the arguments | code.claude.com/docs/en/skills (frontmatter reference) | confirmed |
| Cursor reads `.cursor/mcp.json`, supports `url` and `headers`, and interpolates `${env:NAME}` in `command`, `args`, `env`, `url` and `headers` | cursor.com/docs/context/mcp (Config interpolation) | confirmed: `.cursor/mcp.json` sends `Authorization: Bearer ${env:EXOS_LOCAL_TOKEN}` |

What these facts do not show is that either client loads these files: `claude plugin validate
./plugin --strict` and opening the folder in Cursor are the maintainer's steps.
