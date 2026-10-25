// The bridge over stdio, for `.mcp.json` (Claude Code) and other local clients. stdout carries the
// protocol only, so nothing here may print to it.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { loadToken } from "./auth.ts";
import { makeContext } from "./context.ts";
import { createMcpServer } from "./mcp.ts";
import { registerTools } from "./tools/index.ts";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const ctx = makeContext({
    stackdUrl: env.EXOS_STACKD_URL || `http://127.0.0.1:${env.EXOS_STACKD_PORT || 9812}`,
    stackdToken: loadToken(env),
    dashboardUrl: `http://127.0.0.1:${env.EXOS_DASHBOARD_PORT || 9800}`,
  });
  await createMcpServer(ctx, registerTools).connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`exos-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
