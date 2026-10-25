// The facts doctor checks D-01..D-22 (BUILD.md §15) are computed from. A collector reads the real
// stack into this shape; the seeded policy dataset (data/generator) produces it directly, so the
// doctor is a pure function of a snapshot. It holds names and metadata only: never a secret value.
import { z } from "zod";

const sandboxProvider = z.enum(["smolvm", "firecracker", "docker", "local_process"]);

export const stackSnapshotSchema = z.object({
  exo: z.object({
    commit: z.string(),
    pin: z.string(),
    /** Address `exo run --serve` is bound to, e.g. 127.0.0.1:9810. */
    bind: z.string(),
    serve_flags: z.array(z.string()),
  }),
  compose: z.object({
    /** Every published port of every service, as written in compose (short syntax). */
    ports: z.array(z.string()),
    network_modes: z.array(z.string()),
  }),
  listeners: z.array(z.object({ service: z.string(), host: z.string(), port: z.number().int() })),
  env: z.object({
    /** Variable NAMES per env file (.env, .env.local, ...). */
    files: z.record(z.string(), z.array(z.string())),
    process: z.array(z.string()),
    compose: z.array(z.string()),
  }),
  vault: z.object({
    shared: z.boolean(),
    identities: z.number().int(),
    secrets: z.array(z.object({ name: z.string(), origins: z.array(z.string()) })),
  }),
  agents: z.array(
    z.object({
      slug: z.string(),
      harness: z.string(),
      environment: z.string(),
      use_sender_vault: z.boolean(),
      adapters: z.array(
        z.object({
          type: z.string(),
          vault: z.string().optional(),
          allowed_channels: z.array(z.string()),
        }),
      ),
    }),
  ),
  environments: z.array(
    z.object({
      name: z.string(),
      provider: sandboxProvider,
      networking: z.enum(["limited", "full", "none"]),
      allowed_hosts: z.array(z.string()),
      mounts: z.array(z.string()),
    }),
  ),
  /** Per-agent hosts permitted by environments/allowlists.yaml. */
  allowlists: z.record(z.string(), z.array(z.string())),
  mcp_servers: z.array(
    z.object({
      agent: z.string(),
      name: z.string(),
      url: z.string(),
      permission_policy: z.enum(["always_allow", "always_ask"]),
      write_tools_policy: z.enum(["always_allow", "always_ask"]),
      has_credential: z.boolean(),
    }),
  ),
  mode_a: z.object({
    deny_list: z.array(z.string()),
    bypass_disabled: z.boolean(),
    mount: z.enum(["worktree", "repo", "home"]),
  }),
  claude: z.object({ present: z.boolean(), version: z.string().optional() }),
  mode_b: z.object({
    secret_origin: z.string().optional(),
    provider: sandboxProvider.nullable(),
    substitution_verified: z.boolean(),
  }),
  cursor: z.object({ secret_origin: z.string().optional() }),
  meter: z.object({
    lag_seconds: z.number(),
    /** Turns started outside the stack; absent when the collector could not count them. */
    external_turns: z.number().int().optional(),
  }),
  permissions: z.object({
    token_mode: z.string(),
    state_dir_mode: z.string(),
    /** Mode of the dashboard login token file, when it exists. */
    dashboard_token_mode: z.string().optional(),
  }),
  price_table: z.object({ retrieved_at: z.string(), now: z.string() }),
  submodule: z.object({ dirty: z.boolean(), patches_recorded: z.boolean() }),
  workflows: z.array(
    z.object({ file: z.string(), runs_live_target: z.boolean(), holds_model_secret: z.boolean() }),
  ),
  mcp_clients: z.array(
    z.object({
      file: z.string(),
      servers: z.array(
        z.object({ name: z.string(), kind: z.enum(["stdio", "url"]), url: z.string().optional() }),
      ),
    }),
  ),
  dashboard_only_tools: z.array(z.string()),
  /** Checks the collector could not gather facts for, by id, with the reason. They are skipped. */
  unavailable: z.record(z.string(), z.string()).optional(),
});

export type StackSnapshot = z.infer<typeof stackSnapshotSchema>;
