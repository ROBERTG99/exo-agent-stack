// What stackd knows about an agent, derived from the harness Exo reports for it. The mapping from
// harness to environment is this stack's convention (BUILD.md §4.5): Mode A and the local model run
// as local processes in `host-a`, Mode B in `smolvm-default` with the vault `personal`. Whether
// Exo accepts those environment names is unverified (V-3).
import type { ExoClient } from "@exos/exo-client";
import { notFound } from "./errors.ts";

export type Mode = "A" | "B" | "cursor" | "local";

export interface AgentInfo {
  id: string;
  slug: string;
  name: string;
  harness: string;
  mode: Mode;
  environment: string | null;
  vaults: string[];
}

export function modeOf(harness: string): Mode {
  if (harness.includes("claude-sandboxed")) return "B";
  if (harness.includes("local-shim") || harness.includes("exo-adapter")) return "local";
  if (harness === "cursor" || harness.includes("cursor")) return "cursor";
  return "A";
}

export function describeAgent(raw: {
  id: string;
  slug?: unknown;
  name?: unknown;
  harness?: unknown;
}): AgentInfo {
  const harness = typeof raw.harness === "string" ? raw.harness : "";
  const mode = modeOf(harness);
  const slug =
    typeof raw.slug === "string" ? raw.slug : typeof raw.name === "string" ? raw.name : raw.id;
  return {
    id: raw.id,
    slug,
    name: typeof raw.name === "string" ? raw.name : slug,
    harness,
    mode,
    environment: mode === "B" ? "smolvm-default" : mode === "cursor" ? null : "host-a",
    vaults: mode === "B" ? ["personal"] : [],
  };
}

/** The credit pool an agent's spend counts against (BUILD.md §4.8). */
export const poolOf = (agent: Pick<AgentInfo, "mode">): "anthropic" | "cursor" | "local" =>
  agent.mode === "cursor" ? "cursor" : agent.mode === "local" ? "local" : "anthropic";

export async function listAgents(exo: ExoClient): Promise<AgentInfo[]> {
  return (await exo.listAgents()).map((a) => describeAgent(a as never));
}

/** An agent by slug or id. */
export async function resolveAgent(exo: ExoClient, ref: string): Promise<AgentInfo> {
  const found = (await listAgents(exo)).find((a) => a.slug === ref || a.id === ref);
  if (!found) throw notFound(`agent ${ref}`);
  return found;
}

/**
 * The agent catalogue as last seen. Routes check credit against a cached entry before they make
 * any Exo request, so a stopped pool is refused without touching Exo (BUILD.md §4.8). The cache
 * fills whenever the catalogue is read, including by the meter's regular passes.
 */
export class AgentDirectory {
  private readonly byRef = new Map<string, AgentInfo>();

  constructor(private readonly exo: ExoClient) {}

  async list(): Promise<AgentInfo[]> {
    const agents = await listAgents(this.exo);
    this.byRef.clear();
    for (const a of agents) {
      this.byRef.set(a.slug, a);
      this.byRef.set(a.id, a);
    }
    return agents;
  }

  peek(ref: string): AgentInfo | undefined {
    return this.byRef.get(ref);
  }

  async resolve(ref: string): Promise<AgentInfo> {
    const found = (await this.list()).find((a) => a.slug === ref || a.id === ref);
    if (!found) throw notFound(`agent ${ref}`);
    return found;
  }
}
