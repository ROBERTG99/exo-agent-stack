// Offline demo against the running compose stack. T-06 lists agents; T-50 extends this to
// delegate, approve, recover and fork. Needs `make up` first.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface AgentRow {
  id: string;
  slug?: string;
  name?: string;
  harness?: string;
}

export function renderAgents(agents: AgentRow[]): string {
  if (agents.length === 0) return "no agents registered";
  const rows = agents.map((a) => [a.slug ?? a.name ?? a.id, a.harness ?? "-"]);
  const width = Math.max("SLUG".length, ...rows.map((r) => r[0]!.length));
  return [
    `${"SLUG".padEnd(width)}  HARNESS`,
    ...rows.map(([slug, harness]) => `${slug!.padEnd(width)}  ${harness}`),
  ].join("\n");
}

export function resolveToken(env: Record<string, string | undefined>, stateDir: string): string {
  if (env.EXOS_LOCAL_TOKEN) return env.EXOS_LOCAL_TOKEN;
  const file = join(stateDir, "local-token");
  if (!existsSync(file)) {
    throw new Error(`no local token: set EXOS_LOCAL_TOKEN or start the stack (expected ${file})`);
  }
  return readFileSync(file, "utf8").trim();
}

async function main(): Promise<void> {
  const port = process.env.EXOS_STACKD_PORT || "9812";
  const stateDir = process.env.EXOS_DEMO_STATE_DIR || ".exos-state/compose";
  const token = resolveToken(process.env, stateDir);
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`stackd answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { agents: AgentRow[] };
  console.log(`stackd lists ${body.agents.length} agent(s):\n`);
  console.log(renderAgents(body.agents));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`demo failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
