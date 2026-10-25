/** MCP tool Claude Code calls for every permission prompt (server `exos_approvals`, tool `prompt`). */
export const APPROVAL_TOOL = "mcp__exos_approvals__prompt";

export interface ClaudeArgsInput {
  model: string;
  mcpConfigPath: string;
  resumeSessionId?: string;
}

const safeValue = (v: string, what: string): string => {
  if (v === "" || v.startsWith("-")) throw new Error(`invalid ${what}: ${JSON.stringify(v)}`);
  return v;
};

/**
 * The headless invocation of BUILD.md §4.7. Two additions, both from `claude --help`:
 * --strict-mcp-config keeps the maintainer's global MCP servers out of an unattended run, and
 * --setting-sources local makes the settings.local.json written for this turn the only source of
 * permission rules, so a user-level allow rule cannot bypass the approvals gate.
 * --permission-prompt-tool is supported but hidden (fixtures/claude-help/hidden-flags.txt).
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    safeValue(input.model, "model"),
    "--permission-prompt-tool",
    APPROVAL_TOOL,
    "--mcp-config",
    safeValue(input.mcpConfigPath, "mcp config path"),
    "--strict-mcp-config",
    "--setting-sources",
    "local",
  ];
  if (input.resumeSessionId !== undefined)
    args.push("--resume", safeValue(input.resumeSessionId, "session id"));
  return args;
}
