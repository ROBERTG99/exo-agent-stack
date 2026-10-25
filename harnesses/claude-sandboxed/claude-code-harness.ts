// The module Exo loads for the Mode B agents. Exo binds the model credential to the sandbox
// variable ANTHROPIC_API_KEY as a placeholder because this file is named claude-code-harness.ts;
// ./mode-b-env.ts maps that placeholder to what Claude Code reads. The `defineHarness` wrapper is
// not written yet (verification items V-2, V-9 and V-12, docs/KNOWN_LIMITATIONS.md); until then
// this file deliberately has no default export, so Exo refuses to load it and doctor reports
// Mode B as unsupported.
export { modeBEnv, ModeBPlaceholderError } from "./mode-b-env.ts";
