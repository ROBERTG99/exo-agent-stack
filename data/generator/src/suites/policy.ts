import type { StackSnapshot } from "@exos/common";
import { caseId, splitCases, type Rng } from "../prng.ts";

export const EXO_PIN = "f9f012730fd3bf7e061e3e947e01bd6c2bb415e9";

// Variable names are assembled so this source never contains a literal API-key assignment.
const KEY_VAR_ANTHROPIC = ["ANTHROPIC", "API", "KEY"].join("_");
const KEY_VAR_OPENAI = ["OPENAI", "API", "KEY"].join("_");

const SMOLVM_HOSTS = {
  "repo-builder-b": [
    "api.anthropic.com",
    "github.com",
    "api.github.com",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
  ],
  "reviewer-cursor": ["cursor-sdk.example.org"],
  "researcher-b": ["api.anthropic.com"],
};

/** The clean, fully compliant stack every misconfiguration starts from. */
export function cleanSnapshot(): StackSnapshot {
  const hosts = [...new Set(Object.values(SMOLVM_HOSTS).flat())].sort();
  return {
    exo: {
      commit: EXO_PIN,
      pin: EXO_PIN,
      bind: "127.0.0.1:9810",
      serve_flags: ["--serve", "--bind", "127.0.0.1:9810"],
    },
    compose: {
      ports: [
        "127.0.0.1:9800:9800",
        "127.0.0.1:9811:9811",
        "127.0.0.1:9812:9812",
        "127.0.0.1:9840:9840",
        "127.0.0.1:9841:8080",
      ],
      network_modes: [],
    },
    listeners: [
      { service: "dashboard", host: "127.0.0.1", port: 9800 },
      { service: "exo", host: "127.0.0.1", port: 9810 },
      { service: "bridge", host: "127.0.0.1", port: 9811 },
      { service: "stackd", host: "127.0.0.1", port: 9812 },
      { service: "fake-model", host: "127.0.0.1", port: 9840 },
    ],
    env: {
      files: { ".env": ["EXOS_STATE_DIR", "EXOS_MONTHLY_CREDIT_USD", "EXOS_LISTEN_HOST"] },
      process: ["PATH", "HOME", "EXOS_STATE_DIR"],
      compose: ["EXOS_LISTEN_HOST", "EXOS_STACKD_PORT"],
    },
    vault: {
      shared: false,
      identities: 1,
      secrets: [
        { name: "claude-oauth", origins: ["https://api.anthropic.com"] },
        { name: "cursor", origins: ["https://cursor-sdk.example.org"] },
        { name: "github", origins: ["https://api.github.com"] },
      ],
    },
    agents: [
      agent("repo-builder", "claude-host", "host-a"),
      agent("repo-builder-b", "claude-sandboxed", "smolvm-default"),
      agent("reviewer-cursor", "cursor", "smolvm-default"),
      agent("dual-review", "claude-host", "host-a"),
      agent("local-harness", "exo-adapter", "ci-local"),
      {
        ...agent("ops-slack", "claude-host", "host-a"),
        adapters: [{ type: "slack", vault: "ops-slack", allowed_channels: ["C0EXOSOPS"] }],
      },
      agent("researcher", "claude-host", "host-a"),
    ],
    environments: [
      {
        name: "smolvm-default",
        provider: "smolvm",
        networking: "limited",
        allowed_hosts: hosts,
        mounts: ["/workspace"],
      },
      {
        name: "docker-fallback",
        provider: "docker",
        networking: "limited",
        allowed_hosts: [],
        mounts: ["/workspace"],
      },
      {
        name: "host-a",
        provider: "local_process",
        networking: "full",
        allowed_hosts: [],
        mounts: ["<thread worktree>"],
      },
      {
        name: "ci-local",
        provider: "local_process",
        networking: "none",
        allowed_hosts: [],
        mounts: [],
      },
    ],
    allowlists: SMOLVM_HOSTS,
    mcp_servers: [
      {
        agent: "researcher",
        name: "deepwiki",
        url: "https://mcp.deepwiki.com/mcp",
        permission_policy: "always_allow",
        write_tools_policy: "always_ask",
        has_credential: false,
      },
      {
        agent: "researcher",
        name: "playwright",
        url: "http://127.0.0.1:9843/mcp",
        permission_policy: "always_ask",
        write_tools_policy: "always_ask",
        has_credential: false,
      },
    ],
    mode_a: {
      deny_list: [
        "Bash( trash -rf:*)",
        "Bash(git push --force:*)",
        "Bash(curl:*)",
        "Bash(ssh:*)",
        "Read(**/.env)",
        "Read(~/.ssh/**)",
        "Read(~/.claude/**)",
        "Read(~/.exo-agent-stack/**)",
      ],
      bypass_disabled: true,
      mount: "worktree",
    },
    claude: { present: true, version: "2.1.212" },
    mode_b: { provider: null, substitution_verified: false },
    cursor: { secret_origin: "https://cursor-sdk.example.org" },
    meter: { lag_seconds: 4, external_turns: 0 },
    permissions: { token_mode: "0600", state_dir_mode: "0700" },
    price_table: { retrieved_at: "2026-10-01", now: "2026-10-25" },
    submodule: { dirty: false, patches_recorded: true },
    workflows: [
      { file: "ci.yml", runs_live_target: false, holds_model_secret: false },
      { file: "evals.yml", runs_live_target: false, holds_model_secret: false },
    ],
    mcp_clients: [
      {
        file: ".mcp.json",
        servers: [
          { name: "exos-bridge", kind: "stdio" },
          { name: "playwright", kind: "stdio" },
        ],
      },
      {
        file: ".cursor/mcp.json",
        servers: [{ name: "exos-bridge", kind: "url", url: "http://127.0.0.1:9811/mcp" }],
      },
    ],
    dashboard_only_tools: [
      "claude.Bash(git push:*)",
      "claude.Bash(npm publish:*)",
      "claude.WebFetch",
    ],
  };
}

function agent(slug: string, harness: string, environment: string) {
  return {
    slug,
    harness,
    environment,
    use_sender_vault: false,
    adapters: [] as StackSnapshot["agents"][number]["adapters"],
  };
}

interface Mutation {
  check: string;
  description: string;
  apply: (s: StackSnapshot) => void;
}

/** 25 single-fault mutations; each must make exactly its own check fail (FR-13, BUILD.md §11). */
export const MUTATIONS: Mutation[] = [
  {
    check: "D-01",
    description: "Exo commit differs from the pinned commit",
    apply: (s) => void (s.exo.commit = "0".repeat(40)),
  },
  {
    check: "D-02",
    description: "Exo serve is bound to all interfaces",
    apply: (s) => void (s.exo.bind = "0.0.0.0:9810"),
  },
  {
    check: "D-02",
    description: "Exo serve runs with --auth-file",
    apply: (s) => void s.exo.serve_flags.push("--auth-file", "/tmp/auth.json"),
  },
  {
    check: "D-02",
    description: "Exo serve runs with --multiplayer",
    apply: (s) => void s.exo.serve_flags.push("--multiplayer"),
  },
  {
    check: "D-03",
    description: "A compose port is published without the 127.0.0.1 prefix",
    apply: (s) => void s.compose.ports.push("9801:9801"),
  },
  {
    check: "D-04",
    description: "stackd listens on all interfaces",
    apply: (s) => void (s.listeners.find((l) => l.service === "stackd")!.host = "0.0.0.0"),
  },
  {
    check: "D-04",
    description: "The bridge listens on a LAN address",
    apply: (s) => void (s.listeners.find((l) => l.service === "bridge")!.host = "192.168.1.20"),
  },
  {
    check: "D-05",
    description: "An env file declares an Anthropic API key variable",
    apply: (s) => void s.env.files[".env"]!.push(KEY_VAR_ANTHROPIC),
  },
  {
    check: "D-05",
    description: "The process environment carries an OpenAI API key variable",
    apply: (s) => void s.env.process.push(KEY_VAR_OPENAI),
  },
  {
    check: "D-06",
    description: "A vault secret is named anthropic",
    apply: (s) =>
      void s.vault.secrets.push({ name: "anthropic", origins: ["https://api.anthropic.com"] }),
  },
  {
    check: "D-06",
    description: "A vault secret is scoped to api.openai.com",
    apply: (s) =>
      void s.vault.secrets.push({ name: "helper", origins: ["https://api.openai.com"] }),
  },
  {
    check: "D-06",
    description: "A second secret is scoped to api.anthropic.com besides claude-oauth",
    apply: (s) =>
      void s.vault.secrets.push({ name: "claude-token-2", origins: ["https://api.anthropic.com"] }),
  },
  {
    check: "D-07",
    description: "The vault is shared between identities",
    apply: (s) => void ((s.vault.shared = true), (s.vault.identities = 2)),
  },
  {
    check: "D-08",
    description: "An agent enables use_sender_vault",
    apply: (s) => void (s.agents.find((a) => a.slug === "ops-slack")!.use_sender_vault = true),
  },
  {
    check: "D-08",
    description: "The Slack adapter has no allowed channels",
    apply: (s) =>
      void (s.agents.find((a) => a.slug === "ops-slack")!.adapters[0]!.allowed_channels = []),
  },
  {
    check: "D-09",
    description: "A sandboxed environment has unrestricted networking",
    apply: (s) =>
      void (s.environments.find((e) => e.name === "smolvm-default")!.networking = "full"),
  },
  {
    check: "D-10",
    description: "An environment allows a host outside allowlists.yaml",
    apply: (s) =>
      void s.environments
        .find((e) => e.name === "smolvm-default")!
        .allowed_hosts.push("exfil.example.org"),
  },
  {
    check: "D-11",
    description: "An MCP server's write tools are always_allow",
    apply: (s) =>
      void (s.mcp_servers.find((m) => m.name === "deepwiki")!.write_tools_policy = "always_allow"),
  },
  {
    check: "D-12",
    description: "Mode A deny list lacks the rm -rf rule",
    apply: (s) =>
      void (s.mode_a.deny_list = s.mode_a.deny_list.filter((d) => d !== "Bash( trash -rf:*)")),
  },
  {
    check: "D-12",
    description: "Mode A allows bypass-permissions mode and mounts the home directory",
    apply: (s) => void ((s.mode_a.bypass_disabled = false), (s.mode_a.mount = "home")),
  },
  {
    check: "D-17",
    description: "The local token file is group-readable",
    apply: (s) => void (s.permissions.token_mode = "0644"),
  },
  {
    check: "D-19",
    description: "The Exo submodule is modified without a recorded patch",
    apply: (s) => void ((s.submodule.dirty = true), (s.submodule.patches_recorded = false)),
  },
  {
    check: "D-20",
    description: "A workflow runs a live target",
    apply: (s) =>
      void s.workflows.push({
        file: "nightly.yml",
        runs_live_target: true,
        holds_model_secret: true,
      }),
  },
  {
    check: "D-21",
    description: "A client MCP config points at a non-loopback URL",
    apply: (s) =>
      void s.mcp_clients[1]!.servers.push({
        name: "remote",
        kind: "url",
        url: "https://bridge.example.org/mcp",
      }),
  },
  {
    check: "D-22",
    description: "The dashboard-only tool list is empty",
    apply: (s) => void (s.dashboard_only_tools = []),
  },
];

/** Ten compliant stacks that differ in benign ways (price age, lag, provider, extras). */
function cleanVariant(i: number, rng: Rng): StackSnapshot {
  const s = cleanSnapshot();
  s.price_table.retrieved_at = `2026-${rng.pick(["07", "08", "09", "10"])}-${String(rng.int(10, 24)).padStart(2, "0")}`;
  s.meter.lag_seconds = rng.int(0, 25);
  s.claude.version = rng.pick(["2.1.200", "2.1.205", "2.1.212"]);
  s.env.files[".env"]!.push(...Array.from({ length: i }, (_, k) => `EXOS_EXTRA_SETTING_${k + 1}`));
  if (i % 3 === 0) {
    s.mode_b = {
      secret_origin: "https://api.anthropic.com",
      provider: "smolvm",
      substitution_verified: true,
    };
  } else if (i % 3 === 1) {
    s.mode_b = {
      secret_origin: "https://api.anthropic.com",
      provider: "firecracker",
      substitution_verified: true,
    };
  }
  if (i % 2 === 1) s.dashboard_only_tools.push(`claude.Bash(deploy-${i}:*)`);
  s.workflows.push({ file: `extra-${i}.yml`, runs_live_target: false, holds_model_secret: false });
  return s;
}

/** 35 cases (8 dev / 27 test): 25 seeded misconfigurations plus 10 clean stacks. */
export function policySuite(rng: Rng) {
  const cases: {
    id: string;
    suite: string;
    kind: "misconfig" | "clean";
    description: string;
    expect_fail: string[];
    snapshot: StackSnapshot;
  }[] = [];
  let n = 0;
  for (const m of MUTATIONS) {
    const snapshot = cleanSnapshot();
    m.apply(snapshot);
    cases.push({
      id: caseId("pol", ++n),
      suite: "policy",
      kind: "misconfig",
      description: m.description,
      expect_fail: [m.check],
      snapshot,
    });
  }
  for (let i = 0; i < 10; i++) {
    cases.push({
      id: caseId("pol", ++n),
      suite: "policy",
      kind: "clean",
      description: `Compliant stack, variant ${i + 1}`,
      expect_fail: [],
      snapshot: cleanVariant(i, rng),
    });
  }
  // Dev needs both kinds so the dev split can be used to debug the doctor; reshuffle until it does.
  for (let attempt = 0; ; attempt++) {
    const split = splitCases(rng.child(`policy-split-${attempt}`), cases, 8);
    const kinds = new Set(split.dev.map((c) => c.kind));
    if (kinds.size === 2) return split;
  }
}
