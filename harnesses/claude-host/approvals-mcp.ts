// The stdio MCP server Claude Code starts via --mcp-config. Claude calls its `prompt` tool for
// every permission prompt (--permission-prompt-tool mcp__exos_approvals__prompt); the call is
// forwarded to the harness's broker, which turns it into context.authorizeTool({name: "claude.<Tool>"}).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { askBroker } from "./broker.ts";

export function createApprovalsServer(socketPath: string | undefined): McpServer {
  const server = new McpServer({ name: "exos_approvals", version: "0.1.0" });
  server.registerTool(
    "prompt",
    {
      description:
        "Ask the operator whether Claude Code may use a tool. Returns {behavior: allow|deny}.",
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async ({ tool_name, input }) => {
      const reply = socketPath
        ? await askBroker(socketPath, { tool_name, input })
        : ({ behavior: "deny", message: "approval service unavailable" } as const);
      return { content: [{ type: "text" as const, text: JSON.stringify(reply) }] };
    },
  );
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createApprovalsServer(process.env.EXOS_APPROVALS_SOCKET);
  await server.connect(new StdioServerTransport());
}
