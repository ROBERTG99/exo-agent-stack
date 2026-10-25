// `exos agents sync`: make Exo's managed agents match the definitions in agents/ (BUILD.md FR-2).
// New definitions are created, changed ones updated, unchanged ones left alone, so a second run
// sends nothing that changes anything. Only the request body (managedAgentBody) depends on how Exo
// expects a definition (verification item V-11, docs/KNOWN_LIMITATIONS.md).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex } from "@exos/common";
import { agentFiles, lintAgentDir, parseAgentText } from "@exos/doctor/agent-schema";
import { ExoClient, ExoHttpError, ExoUnavailableError } from "@exos/exo-client";
import type { CommandIo } from "../main.ts";

export interface Definition {
  name: string;
  file: string;
  front: Record<string, unknown>;
  body: string;
}

const BUILTIN_HARNESSES = new Set(["cursor"]);

/**
 * Hand-written definitions overlaid with the generated ones: a generated file replaces a
 * hand-written one of the same name (for example ops-slack with a fleet MCP entry) and may add new
 * agents (dual-review-cursor). Sorted by name.
 */
export function collectDefinitions(agentsDir: string): Definition[] {
  const byName = new Map<string, Definition>();
  const load = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const file of agentFiles(dir)) {
      const { front, body } = parseAgentText(readFileSync(file, "utf8"), file);
      const name = String(front.name);
      byName.set(name, { name, file, front, body });
    }
  };
  load(agentsDir);
  load(path.join(agentsDir, "generated"));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The request body for one agent. Paths in a definition are relative to its Markdown file, which an
 * HTTP API cannot know, so they are sent as absolute paths.
 */
export function managedAgentBody(def: Definition): Record<string, unknown> {
  const base = path.dirname(def.file);
  const abs = (p: unknown) => (typeof p === "string" ? path.resolve(base, p) : p);
  const front = { ...def.front } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- parsed YAML
  if (typeof front.harness === "string" && !BUILTIN_HARNESSES.has(front.harness))
    front.harness = abs(front.harness);
  if (Array.isArray(front.tools)) front.tools = front.tools.map(abs);
  if (Array.isArray(front.resources))
    front.resources = front.resources.map((r: Record<string, unknown>) => ({
      ...r,
      path: abs(r.path),
    }));
  return { slug: def.name, definition: front, instructions: def.body };
}

interface State {
  version: 1;
  agents: Record<string, { id: string; sha256: string }>;
}

function readState(file: string): State {
  if (!existsSync(file)) return { version: 1, agents: {} };
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as State;
    return s.version === 1 && s.agents ? s : { version: 1, agents: {} };
  } catch {
    return { version: 1, agents: {} };
  }
}

function writeState(file: string, state: State): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

export interface SyncOptions {
  client: ExoClient;
  agentsDir: string;
  statePath: string;
  dryRun?: boolean;
}

export interface SyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  errors: { name: string; message: string }[];
}

export async function syncAgents(opts: SyncOptions): Promise<SyncResult> {
  const diagnostics = [
    ...lintAgentDir(opts.agentsDir, { checkPaths: true }),
    ...(existsSync(path.join(opts.agentsDir, "generated"))
      ? lintAgentDir(path.join(opts.agentsDir, "generated"), { checkPaths: true })
      : []),
  ];
  if (diagnostics.length > 0) {
    const d = diagnostics[0]!;
    throw new Error(
      `agent definitions do not pass lint (${diagnostics.length} problem(s)); first: ${d.file}:${d.line}: ${d.rule}: ${d.message}`,
    );
  }

  const definitions = collectDefinitions(opts.agentsDir);
  const remote = new Map(
    (await opts.client.listAgents()).map((a) => [String(a.slug ?? a.name ?? ""), a.id]),
  );
  const state = readState(opts.statePath);
  const next: State = { version: 1, agents: {} };
  const result: SyncResult = { created: [], updated: [], unchanged: [], errors: [] };

  for (const def of definitions) {
    const body = managedAgentBody(def);
    const sha256 = sha256Hex(canonicalJson(body));
    const id = remote.get(def.name);
    try {
      if (id === undefined) {
        if (!opts.dryRun) {
          const res = await opts.client.createManagedAgent(body);
          next.agents[def.name] = { id: idOf(res), sha256 };
        }
        result.created.push(def.name);
      } else if (state.agents[def.name]?.sha256 === sha256 && state.agents[def.name]?.id === id) {
        next.agents[def.name] = { id, sha256 };
        result.unchanged.push(def.name);
      } else {
        if (!opts.dryRun) {
          await opts.client.updateAgentDefinition(id, body);
          next.agents[def.name] = { id, sha256 };
        }
        result.updated.push(def.name);
      }
    } catch (err) {
      if (err instanceof ExoUnavailableError) throw err;
      result.errors.push({
        name: def.name,
        message: err instanceof ExoHttpError ? err.message : (err as Error).message,
      });
    }
  }

  if (!opts.dryRun) writeState(opts.statePath, next);
  return result;
}

function idOf(res: Record<string, unknown>): string {
  const agent = res.agent as Record<string, unknown> | undefined;
  const id = agent?.id ?? res.id;
  if (typeof id !== "string") throw new Error("Exo did not return the id of the created agent");
  return id;
}

export async function runAgentsSync(args: string[], io: CommandIo): Promise<number> {
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const agentsDir = option("--agents") ?? "agents";
  if (!existsSync(agentsDir) || !readdirSync(agentsDir).length) {
    io.err(`agents directory not found: ${agentsDir}`);
    return 2;
  }
  const stateDir = io.env.EXOS_STATE_DIR || ".exos-state";
  const baseUrl = io.env.EXOS_EXO_URL || `http://127.0.0.1:${io.env.EXOS_EXO_PORT || "9810"}/exo`;
  const dryRun = args.includes("--dry-run");

  let result: SyncResult;
  try {
    result = await syncAgents({
      client: new ExoClient({ baseUrl, retries: 1 }),
      agentsDir,
      statePath: option("--state") ?? path.join(stateDir, "agents-sync.json"),
      dryRun,
    });
  } catch (err) {
    io.err(`agents sync failed: ${(err as Error).message}`);
    return 1;
  }

  if (args.includes("--json")) {
    io.out(JSON.stringify(result));
  } else {
    for (const n of result.created) io.out(`${dryRun ? "would create" : "created"} ${n}`);
    for (const n of result.updated) io.out(`${dryRun ? "would update" : "updated"} ${n}`);
    for (const n of result.unchanged) io.out(`unchanged ${n}`);
    io.out(
      `agents sync: ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged${result.errors.length ? `, ${result.errors.length} failed` : ""}`,
    );
  }
  for (const e of result.errors) io.err(`${e.name}: ${e.message}`);
  return result.errors.length > 0 ? 1 : 0;
}
