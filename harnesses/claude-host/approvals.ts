export interface ApprovalRequest {
  name: string;
  arguments: unknown;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export type McpDecision =
  { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/** Claude Code tool name -> the name policies and the dashboard use: Bash -> claude.Bash. */
export function toExoToolName(claudeToolName: string): string {
  if (!TOOL_NAME.test(claudeToolName))
    throw new Error(`invalid tool name ${JSON.stringify(claudeToolName)}`);
  return `claude.${claudeToolName}`;
}

/** The JSON Claude Code expects back from a --permission-prompt-tool call. */
export function toMcpDecision(decision: ApprovalDecision, input: unknown): McpDecision {
  if (decision.approved) return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: decision.reason ?? "denied by the operator" };
}
