// Environment definitions (BUILD.md §4.5, FR-3): where an agent's turns run and what they may
// reach. The YAML format is this stack's own description; stackd translates it into
// `exo environment create|update` calls, whose flags are unverified (docs/KNOWN_LIMITATIONS.md).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { StackSnapshot } from "@exos/common";

const network = z
  .strictObject({
    mode: z.enum(["limited", "none", "host"]),
    allowed_tcp_ports: z.array(z.number().int()).optional(),
    allowed_hosts_from: z.string().optional(),
  })
  .superRefine((n, ctx) => {
    if (n.mode !== "limited") return;
    const ports = n.allowed_tcp_ports ?? [];
    if (ports.length !== 1 || ports[0] !== 443) {
      ctx.addIssue({
        code: "custom",
        message: "limited networking must allow exactly TCP port 443",
      });
    }
    if (!n.allowed_hosts_from)
      ctx.addIssue({ code: "custom", message: "limited networking needs allowed_hosts_from" });
  });

export const environmentSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  provider: z.enum(["smolvm", "firecracker", "docker", "local_process"]),
  resources: z
    .strictObject({
      vcpus: z.number().int().positive(),
      memory_mib: z.number().int().positive(),
      idle_seconds: z.number().int().positive(),
    })
    .optional(),
  network,
  mounts: z.array(z.string()),
  vault_backed_agents: z.enum(["allowed", "forbidden"]),
});

export type Environment = z.infer<typeof environmentSchema>;
export type Allowlists = Record<string, string[]>;

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function loadEnvironments(dir: string): Environment[] {
  const out: Environment[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && f !== "allowlists.yaml")
    .sort()) {
    let raw: unknown;
    try {
      raw = parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      throw new Error(`${file}: invalid YAML (${(err as Error).message.split("\n")[0]})`, {
        cause: err,
      });
    }
    const parsed = environmentSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new Error(`${file}: ${issue.path.join(".") || "environment"}: ${issue.message}`);
    }
    if (parsed.data.name !== file.replace(/\.ya?ml$/, "")) {
      throw new Error(`${file}: name "${parsed.data.name}" must equal the file name`);
    }
    out.push(parsed.data);
  }
  return out;
}

export function loadAllowlists(file: string): Allowlists {
  const raw = parse(readFileSync(file, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path.basename(file)}: allowlist must map agent names to host lists`);
  }
  const out: Allowlists = {};
  for (const [agent, hosts] of Object.entries(raw)) {
    if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === "string")) {
      throw new Error(
        `${path.basename(file)}: allowlist for ${agent} must be a list of host names`,
      );
    }
    for (const h of hosts as string[]) {
      if (!HOST.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) {
        throw new Error(
          `${path.basename(file)}: host "${h}" for ${agent} is not a plain lowercase DNS name (allowlist hosts allow no wildcards, schemes, ports or IP literals)`,
        );
      }
    }
    if (new Set(hosts as string[]).size !== hosts.length) {
      throw new Error(`${path.basename(file)}: allowlist for ${agent} has duplicate hosts`);
    }
    out[agent] = [...(hosts as string[])];
  }
  return out;
}

/** Hosts one agent may reach in `env`: its allowlist for limited networking, nothing otherwise. */
export function resolveAllowedHosts(
  env: Environment,
  allowlists: Allowlists,
  agent: string,
): string[] {
  if (env.network.mode !== "limited") return [];
  return [...(allowlists[agent] ?? [])].sort();
}

/** The `environments` and `allowlists` sections of a StackSnapshot (doctor D-09 and D-10). */
export function snapshotEnvironments(
  envs: Environment[],
  allowlists: Allowlists,
): Pick<StackSnapshot, "environments" | "allowlists"> {
  const union = [...new Set(Object.values(allowlists).flat())].sort();
  return {
    environments: envs.map((e) => ({
      name: e.name,
      provider: e.provider,
      networking:
        e.network.mode === "limited" ? "limited" : e.network.mode === "none" ? "none" : "full",
      allowed_hosts: e.network.mode === "limited" ? union : [],
      mounts: e.mounts,
    })),
    allowlists: Object.fromEntries(Object.entries(allowlists).map(([k, v]) => [k, [...v]])),
  };
}
