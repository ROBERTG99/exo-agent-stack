// D-09 to D-12, D-21 and D-22: what sandboxes may reach, how tools are gated, what clients connect to.
import { fail, isLoopbackHost, list, pass, warn, type Check } from "./types.ts";

/** Rules Mode A must refuse (BUILD.md §4.7); the harness's own list may hold more. */
export const REQUIRED_DENY_RULES = [
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(curl:*)",
  "Bash(ssh:*)",
  "Read(**/.env)",
  "Read(~/.ssh/**)",
  "Read(~/.claude/**)",
  "Read(~/.exo-agent-stack/**)",
];

const SANDBOXED = new Set(["smolvm", "firecracker", "docker"]);

export const policyChecks: Check[] = [
  {
    id: "D-09",
    title: "Sandboxed environments use limited networking",
    run: ({ environments }) => {
      const open = environments.filter(
        (e) => SANDBOXED.has(e.provider) && e.networking !== "limited",
      );
      return open.length === 0
        ? pass(
            `${environments.filter((e) => SANDBOXED.has(e.provider)).length} sandboxed environments, all with limited networking`,
          )
        : fail(
            `sandboxed with ${open.map((e) => `${e.networking} networking`).join(", ")}: ${list(open.map((e) => e.name))}`,
            "Set `network.mode: limited` with allowed_hosts_from: allowlists.yaml on the environment.",
          );
    },
  },
  {
    id: "D-10",
    title: "Allowed hosts stay within allowlists.yaml",
    run: ({ environments, allowlists, agents }) => {
      const known = new Set(Object.values(allowlists).flat());
      const outside: string[] = [];
      for (const e of environments) {
        if (e.networking !== "limited") continue;
        for (const h of e.allowed_hosts) if (!known.has(h)) outside.push(`${h} (${e.name})`);
      }
      if (outside.length > 0) {
        return fail(
          `hosts outside allowlists.yaml: ${list(outside)}`,
          "Remove the host from the environment, or add it to environments/allowlists.yaml for the agent that needs it.",
        );
      }
      // An environment is shared by its agents, so an agent can reach every host the environment
      // allows, which may be more than its own list (docs/KNOWN_LIMITATIONS.md).
      const wider: string[] = [];
      for (const a of agents) {
        const env = environments.find((e) => e.name === a.environment);
        if (!env || env.networking !== "limited") continue;
        const own = new Set(allowlists[a.slug] ?? []);
        const extra = env.allowed_hosts.filter((h) => !own.has(h));
        if (extra.length > 0) wider.push(`${a.slug} (${extra.length} more)`);
      }
      return wider.length === 0
        ? pass("every limited environment allows only hosts listed in allowlists.yaml")
        : warn(
            `within allowlists.yaml, but a shared environment gives some agents hosts beyond their own list: ${list(wider)}`,
            "Give an agent with a short list its own environment, so it cannot reach another agent's hosts.",
          );
    },
  },
  {
    id: "D-11",
    title: "MCP servers have policies and write tools always ask",
    run: ({ mcp_servers }) => {
      const open = mcp_servers.filter((m) => m.write_tools_policy !== "always_ask");
      return open.length === 0
        ? pass(`${mcp_servers.length} MCP servers, write tools always ask`)
        : fail(
            `write tools are not always_ask on: ${list(open.map((m) => `${m.name} (${m.agent})`))}`,
            "Set `write_tools_policy: always_ask` (or per-tool always_ask policies) on the server.",
          );
    },
  },
  {
    id: "D-12",
    title: "Mode A settings: deny list, bypass disabled, worktree-only mount",
    run: ({ mode_a }) => {
      const missing = REQUIRED_DENY_RULES.filter((r) => !mode_a.deny_list.includes(r));
      const problems: string[] = [];
      if (missing.length > 0) problems.push(`deny list lacks ${list(missing)}`);
      if (!mode_a.bypass_disabled) problems.push("bypass-permissions mode is allowed");
      if (mode_a.mount !== "worktree")
        problems.push(`the agent's mount is the ${mode_a.mount}, not the thread worktree`);
      return problems.length === 0
        ? pass(
            `all ${REQUIRED_DENY_RULES.length} required deny rules, bypass disabled, worktree-only mount`,
          )
        : fail(
            problems.join("; "),
            "Restore harnesses/claude-host/settings.ts: the settings file is rewritten for every turn.",
          );
    },
  },
  {
    id: "D-21",
    title: "MCP client configs point only at loopback or stdio",
    run: ({ mcp_clients }) => {
      const bad: string[] = [];
      for (const c of mcp_clients) {
        for (const s of c.servers) {
          if (s.kind !== "url") continue;
          let host = "";
          try {
            host = new URL(s.url ?? "").hostname;
          } catch {
            /* an unreadable URL counts as not loopback */
          }
          if (!host || !isLoopbackHost(host)) bad.push(`${s.name} in ${c.file}`);
        }
      }
      return bad.length === 0
        ? pass(`${mcp_clients.length} client configs, every URL on loopback`)
        : fail(
            `client MCP servers beyond loopback: ${list(bad)}`,
            "Point the entry at 127.0.0.1 or use a stdio command.",
          );
    },
  },
  {
    id: "D-22",
    title: "The dashboard-only tool list is not empty",
    run: ({ dashboard_only_tools }) =>
      dashboard_only_tools.length > 0
        ? pass(`${dashboard_only_tools.length} dashboard-only tool patterns`)
        : fail(
            "no tool is dashboard-only, so the bridge could approve git push or network access",
            "Set EXOS_APPROVE_DASHBOARD_ONLY, or unset it to use the default list.",
          ),
  },
];
