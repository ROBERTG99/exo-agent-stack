// The module Exo loads for the `claude-host` agents (Mode A). The launcher that does the work is
// implemented and tested in ./launcher.ts. The `defineHarness` wrapper is not written yet: it
// needs how Exo's TurnContext exposes the durable conversation (verification item V-12,
// docs/KNOWN_LIMITATIONS.md). This file deliberately has no default export, so Exo refuses to
// load it rather than running something that only looks like a harness.
export { runClaudeTurn, ClaudeNotFoundError } from "./launcher.ts";
