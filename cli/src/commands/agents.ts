import { existsSync, statSync } from "node:fs";
import { agentFiles, lintAgentDir } from "@exos/doctor/agent-schema";
import type { CommandIo } from "../main.ts";
import { runAgentsSync } from "./agents-sync.ts";

const USAGE =
  "usage: exos agents lint [dir] [--no-paths] [--online] | exos agents sync [--agents dir] [--state file] [--dry-run] [--json]";

/** `exos agents lint [dir]`: exit 0 clean, 1 on diagnostics, 2 on usage errors or a missing directory. */
export async function agentsCommand(args: string[], io: CommandIo): Promise<number> {
  if (args[0] === "sync") return runAgentsSync(args.slice(1), io);
  if (args[0] !== "lint") {
    io.err(USAGE);
    return 2;
  }
  const rest = args.slice(1);
  if (rest.includes("--online")) {
    io.err(
      "--online (MCP tool names checked against a running Exo) needs the real Exo and is not available offline; see docs/KNOWN_LIMITATIONS.md",
    );
    return 2;
  }
  const dir = rest.find((a) => !a.startsWith("--")) ?? "agents";
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    io.err(`agents directory not found: ${dir}`);
    return 2;
  }
  const diagnostics = lintAgentDir(dir, { checkPaths: !rest.includes("--no-paths") });
  for (const d of diagnostics) io.err(`${d.file}:${d.line}: ${d.rule}: ${d.message}`);
  const count = agentFiles(dir).length;
  if (diagnostics.length > 0) {
    io.err(`${diagnostics.length} problem(s) in ${count} agent definition(s)`);
    return 1;
  }
  io.out(`${count} agent definition(s) OK`);
  return 0;
}
