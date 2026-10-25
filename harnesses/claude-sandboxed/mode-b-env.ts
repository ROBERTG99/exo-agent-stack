// Mode B runs Claude Code inside a SmolVM sandbox with a setup-token stored in vault `personal` as
// `claude-oauth` (BUILD.md §4.7, FR-5). Exo binds the vault credential to the sandbox variable
// ANTHROPIC_API_KEY as a placeholder (`exo_egress_<id>`) because the harness file is named
// claude-code-harness.ts; the egress proxy swaps the placeholder for the real token on requests to
// https://api.anthropic.com. Claude Code takes an OAuth token from CLAUDE_CODE_OAUTH_TOKEN, so this
// maps the placeholder across, removes the API-key variable, and passes nothing else.
//
// Everything here is the stack's side of the contract. That Exo performs the binding and the
// substitution (V-2, V-9) is not verified yet; doctor reports Mode B as `unsupported` until it is
// (docs/KNOWN_LIMITATIONS.md, docs/adr/0003-mode-b-wrapper.md).

export const PLACEHOLDER_PREFIX = "exo_egress_";

/** The sandbox variable Exo fills with the placeholder (built from parts: it is a variable name). */
export const MODEL_KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");

/** Variables Exo's own claude-code harness forwards, plus a minimal base environment. */
const PASSTHROUGH = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "TRACEPARENT",
  "TRACESTATE",
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
] as const;

const MAX_PLACEHOLDER_LENGTH = 200;

export class ModeBPlaceholderError extends Error {
  readonly code = "mode_b_placeholder";
  constructor(message: string) {
    super(message);
    this.name = "ModeBPlaceholderError";
  }
}

export function modeBEnv(sandboxEnv: Record<string, string | undefined>): Record<string, string> {
  const placeholder = sandboxEnv[MODEL_KEY_VAR];
  if (placeholder === undefined || placeholder === "") {
    throw new ModeBPlaceholderError(
      "no model credential is bound to the sandbox: the agent needs model.credential (claude-oauth)",
    );
  }
  // Only an Exo placeholder may go on. A real token in this variable would mean the sandbox holds a
  // secret the proxy was supposed to keep outside it; stop rather than pass it to Claude Code.
  if (
    !placeholder.startsWith(PLACEHOLDER_PREFIX) ||
    placeholder.length === PLACEHOLDER_PREFIX.length ||
    placeholder.length > MAX_PLACEHOLDER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(placeholder)
  ) {
    throw new ModeBPlaceholderError(
      `the credential in the sandbox is not an Exo egress placeholder (expected ${PLACEHOLDER_PREFIX}<id>)`,
    );
  }

  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = sandboxEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = placeholder;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}
