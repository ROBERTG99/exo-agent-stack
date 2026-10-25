// Reads the real stack into the StackSnapshot that the checks judge. Every fact is read from its
// source (a file, a command's output, stackd's API). When a source is not there (Exo not built, the
// stack not running) the matching checks are marked unavailable and are skipped with the reason,
// instead of being guessed at. Values of secrets are never read: only names, origins and modes.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { isLocalServiceUrl, stackSnapshotSchema, type StackSnapshot } from "@exos/common";
import { buildSettings } from "@exos/claude-host/settings";
import { agentFiles, parseAgentText } from "./agent-schema.ts";
import { loadAllowlists, loadEnvironments, snapshotEnvironments } from "./environments.ts";

const execFileAsync = promisify(execFile);

export interface RunResult {
  ok: boolean;
  stdout: string;
}
export type Run = (
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<RunResult>;

export const run: Run = async (command, args, opts = {}) => {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 3_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" },
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
};

export interface CollectOptions {
  root: string;
  env: Record<string, string | undefined>;
  now?: Date;
  run?: Run;
  fetchImpl?: typeof fetch;
}

/** Ports the stack uses and the service that owns each (BUILD.md §5). */
const SERVICE_PORTS: Record<number, string> = {
  9800: "dashboard",
  9810: "exo",
  9811: "bridge",
  9812: "stackd",
  9840: "fake-model",
  9841: "wiremock",
};

/** Public MCP servers known to offer read tools only (their write policy cannot be read from the definition). */
const READ_ONLY_MCP_URLS = new Set(["https://mcp.deepwiki.com/mcp"]);

/** Tools of a known server that only read; an always_allow override on one of these is fine. */
const READ_ONLY_TOOLS: Record<string, Set<string>> = {
  playwright: new Set([
    "browser_snapshot",
    "browser_take_screenshot",
    "browser_console_messages",
    "browser_network_requests",
  ]),
};

/**
 * Whether the server's write tools ask. Its definition does not list which tools write, so this errs
 * towards "allow": the server must ask by default, and no tool may be allowed without asking unless it
 * is a known read-only tool of that server. A missing default counts as permissive.
 */
function writeToolsPolicy(
  name: string,
  url: string,
  policy: string,
  toolPolicies: unknown,
): "always_allow" | "always_ask" {
  if (READ_ONLY_MCP_URLS.has(url)) return "always_ask";
  if (policy !== "always_ask") return "always_allow";
  const readOnly = READ_ONLY_TOOLS[name] ?? new Set<string>();
  for (const [tool, p] of Object.entries(
    (toolPolicies as Record<string, { type?: string }> | undefined) ?? {},
  )) {
    if (p?.type === "always_allow" && !readOnly.has(tool)) return "always_allow";
  }
  return "always_ask";
}

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, "0");
const exists = (p: string) => existsSync(p);
const readText = (p: string): string => readFileSync(p, "utf8");

function envNames(file: string): string[] {
  const names: string[] = [];
  for (const line of readText(file).split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !line.trimStart().startsWith("#")) names.push(m[1]!);
  }
  return names;
}

function composeFacts(root: string) {
  const ports: string[] = [];
  const networkModes: string[] = [];
  const envVars: string[] = [];
  for (const file of ["compose.yaml", "compose.cloud.yaml"]) {
    const p = path.join(root, file);
    if (!exists(p)) continue;
    const doc = parseYaml(readText(p)) as {
      services?: Record<string, Record<string, unknown>>;
    } | null;
    for (const service of Object.values(doc?.services ?? {})) {
      for (const port of (service.ports as unknown[] | undefined) ?? []) {
        if (typeof port === "string" || typeof port === "number") ports.push(String(port));
        else if (port && typeof port === "object") {
          const o = port as {
            host_ip?: string;
            published?: string | number;
            target?: string | number;
          };
          ports.push(`${o.host_ip ? `${o.host_ip}:` : ""}${o.published ?? ""}:${o.target ?? ""}`);
        }
      }
      if (typeof service.network_mode === "string") networkModes.push(service.network_mode);
      const environment = service.environment;
      if (Array.isArray(environment))
        envVars.push(...environment.map((e) => String(e).split("=")[0]!));
      else if (environment && typeof environment === "object")
        envVars.push(...Object.keys(environment));
    }
  }
  return { ports, networkModes, envVars };
}

function agentFacts(root: string, environments: StackSnapshot["environments"]) {
  const agents: StackSnapshot["agents"] = [];
  const mcp: StackSnapshot["mcp_servers"] = [];
  for (const dir of [path.join(root, "agents"), path.join(root, "agents", "generated")]) {
    if (!exists(dir)) continue;
    for (const file of agentFiles(dir)) {
      const { front } = parseAgentText(readText(file), file);
      const slug = String(front.name ?? path.basename(file, ".md"));
      const harness = String(front.harness ?? "");
      const environment =
        harness.includes("claude-sandboxed") || harness === "cursor" || harness.includes("cursor")
          ? "smolvm-default"
          : "host-a";
      const adapters = ((front.adapters as Array<Record<string, unknown>> | undefined) ?? []).map(
        (a) => ({
          type: String(a.type ?? ""),
          ...(typeof a.vault === "string" ? { vault: a.vault } : {}),
          allowed_channels: Array.isArray(a.allowed_channels) ? a.allowed_channels.map(String) : [],
        }),
      );
      const usesSender =
        front.use_sender_vault === true ||
        ((front.adapters as Array<Record<string, unknown>> | undefined) ?? []).some(
          (a) => a.use_sender_vault === true,
        );
      if (!agents.some((a) => a.slug === slug)) {
        agents.push({
          slug,
          harness,
          environment: environments.some((e) => e.name === environment) ? environment : "host-a",
          use_sender_vault: usesSender,
          adapters,
        });
      }
      for (const server of (front.mcp_servers as Array<Record<string, unknown>> | undefined) ??
        []) {
        const name = String(server.name ?? "");
        const url = String(server.url ?? "");
        const policy = ((server.permission_policy as { type?: string } | undefined)?.type ??
          "always_allow") as "always_allow" | "always_ask";
        mcp.push({
          agent: slug,
          name,
          url,
          permission_policy: policy,
          write_tools_policy: writeToolsPolicy(name, url, policy, server.tool_policies),
          has_credential: typeof server.credential === "string" || typeof server.vault === "string",
        });
      }
    }
  }
  return { agents, mcp };
}

function clientConfigs(root: string): StackSnapshot["mcp_clients"] {
  const out: StackSnapshot["mcp_clients"] = [];
  for (const file of [".mcp.json", ".cursor/mcp.json"]) {
    const p = path.join(root, file);
    if (!exists(p)) continue;
    let doc: { mcpServers?: Record<string, { command?: string; url?: string }> };
    try {
      doc = JSON.parse(readText(p));
    } catch {
      out.push({ file, servers: [{ name: "(unreadable file)", kind: "url", url: "unreadable" }] });
      continue;
    }
    out.push({
      file,
      servers: Object.entries(doc.mcpServers ?? {}).map(([name, s]) =>
        s.url ? { name, kind: "url" as const, url: s.url } : { name, kind: "stdio" as const },
      ),
    });
  }
  return out;
}

function workflowFacts(root: string): StackSnapshot["workflows"] {
  const dir = path.join(root, ".github", "workflows");
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => {
      const text = readText(path.join(dir, file));
      return {
        file,
        runs_live_target: /\bmake\s+(live-claude|live-cursor|eval-live)\b/.test(text),
        holds_model_secret: /secrets\.(ANTHROPIC|OPENAI|OPENROUTER|CLAUDE)[A-Z0-9_]*/.test(text),
      };
    });
}

function parseListeners(output: string): StackSnapshot["listeners"] {
  const out: StackSnapshot["listeners"] = [];
  for (const line of output.split("\n")) {
    const m = /TCP\s+(\*|\[[^\]]+\]|[\d.]+):(\d+)\s+\(LISTEN\)/.exec(line);
    if (!m) continue;
    const port = Number(m[2]);
    const service = SERVICE_PORTS[port];
    if (!service) continue;
    out.push({ service, host: m[1] === "*" ? "0.0.0.0" : m[1]!, port });
  }
  return out;
}

function parseExoProcess(ps: string): { bind: string; flags: string[] } | undefined {
  for (const line of ps.split("\n")) {
    if (!/(^|\/|\s)exo(\s|$)/.test(line) || !line.includes("--serve")) continue;
    const words = line.trim().split(/\s+/);
    const at = words.indexOf("--bind");
    const bind =
      at >= 0
        ? (words[at + 1] ?? "")
        : (words.find((w) => w.startsWith("--bind="))?.slice(7) ?? "");
    return { bind: bind || "0.0.0.0:0", flags: words.filter((w) => w.startsWith("--")) };
  }
  return undefined;
}

export async function collectSnapshot(o: CollectOptions): Promise<StackSnapshot> {
  const sh = o.run ?? run;
  const now = o.now ?? new Date();
  const doFetch = o.fetchImpl ?? fetch;
  const unavailable: Record<string, string> = {};
  const stateDir = path.resolve(o.root, o.env.EXOS_STATE_DIR || ".exos-state");

  // --- Exo -------------------------------------------------------------------------------------
  const tree = await sh("git", ["ls-tree", "HEAD", "vendor/exo"], { cwd: o.root });
  const pin = /^160000 commit ([0-9a-f]{40})/.exec(tree.stdout)?.[1] ?? "";
  let commit = "";
  if (pin && exists(path.join(o.root, "vendor/exo/.git"))) {
    commit = (
      await sh("git", ["-C", "vendor/exo", "rev-parse", "HEAD"], { cwd: o.root })
    ).stdout.trim();
  }
  if (!pin || !commit)
    unavailable["D-01"] = "vendor/exo is not added or not checked out (docs/KNOWN_LIMITATIONS.md)";

  const proc = parseExoProcess((await sh("ps", ["-axo", "command="])).stdout);
  if (!proc) unavailable["D-02"] = "Exo is not running";

  // --- compose, listeners, environment ---------------------------------------------------------
  const compose = composeFacts(o.root);
  const lsof = await sh("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const listeners = lsof.ok ? parseListeners(lsof.stdout) : [];
  if (!lsof.ok) unavailable["D-04"] = "lsof is not available to list listeners";

  const envFiles: Record<string, string[]> = {};
  for (const f of readdirSync(o.root)
    .filter((n) => /^\.env(\..+)?$/.test(n))
    .sort()) {
    envFiles[f] = envNames(path.join(o.root, f));
  }

  // --- definitions -----------------------------------------------------------------------------
  const allowlistsFile = path.join(o.root, "environments", "allowlists.yaml");
  const { environments, allowlists } = snapshotEnvironments(
    loadEnvironments(path.join(o.root, "environments")),
    exists(allowlistsFile) ? loadAllowlists(allowlistsFile) : {},
  );
  const { agents, mcp } = agentFacts(o.root, environments);

  // --- Mode A, claude, Mode B, Cursor ----------------------------------------------------------
  const settings = buildSettings({ worktree: "<worktree>", hookPath: "<hook>" });
  const claudeBin =
    o.env.EXOS_CLAUDE_BIN ||
    (exists("/opt/homebrew/bin/claude") ? "/opt/homebrew/bin/claude" : "claude");
  const claudeVersion = await sh(claudeBin, ["--version"]);
  const claude: StackSnapshot["claude"] = claudeVersion.ok
    ? { present: true, version: /(\d+\.\d+\.\d+)/.exec(claudeVersion.stdout)?.[1] }
    : { present: false };

  unavailable["D-06"] = "vault metadata is read with `exo vault list`, which needs a built Exo";
  unavailable["D-07"] = unavailable["D-06"];

  // --- stackd: meter lag and the dashboard-only list ------------------------------------------------
  const stackdUrl = o.env.EXOS_STACKD_URL || `http://127.0.0.1:${o.env.EXOS_STACKD_PORT || 9812}`;
  const tokenFile = path.join(stateDir, "local-token");
  let lag = 0;
  let dashboardOnly: string[] = [];
  const token = exists(tokenFile) ? readText(tokenFile).trim() : "";
  const stackdIsLocal = isLocalServiceUrl(stackdUrl);
  const getJson = async (p: string): Promise<Record<string, unknown> | undefined> => {
    // The API token goes with the request: never to an address that is not local.
    if (!token || !stackdIsLocal) return undefined;
    try {
      const res = await doFetch(`${stackdUrl}${p}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const usage = await getJson("/api/v1/usage");
  if (typeof usage?.meter_lag_s === "number") lag = usage.meter_lag_s;
  else {
    unavailable["D-16"] = !stackdIsLocal
      ? "EXOS_STACKD_URL is not a local address, so the token is not sent"
      : usage
        ? "the meter has not completed a pass yet"
        : "stackd is not reachable";
  }
  const approvals = await getJson("/api/v1/approvals");
  if (Array.isArray(approvals?.dashboard_only_tools))
    dashboardOnly = approvals.dashboard_only_tools.map(String);
  else {
    unavailable["D-22"] = !stackdIsLocal
      ? "EXOS_STACKD_URL is not a local address, so the token is not sent"
      : "stackd is not reachable";
  }

  // --- files and permissions -------------------------------------------------------------------
  let tokenMode = "0600";
  let dashboardTokenMode: string | undefined;
  let stateMode = "0700";
  if (exists(tokenFile)) {
    tokenMode = octal(statSync(tokenFile).mode);
    stateMode = octal(statSync(stateDir).mode);
    const dt = path.join(stateDir, "dashboard-token");
    if (exists(dt)) dashboardTokenMode = octal(statSync(dt).mode);
  } else {
    unavailable["D-17"] = "the stack has not created its token files yet";
  }

  const rates = JSON.parse(readText(path.join(o.root, "pricing/api-rates.v1.json"))) as {
    retrieved_at: string;
  };

  let dirty = false;
  if (exists(path.join(o.root, "vendor/exo/.git"))) {
    dirty =
      (
        await sh("git", ["-C", "vendor/exo", "status", "--porcelain"], { cwd: o.root })
      ).stdout.trim() !== "";
  } else {
    unavailable["D-19"] = "vendor/exo is not checked out";
  }
  const patchesDir = path.join(o.root, "patches");
  const patchesRecorded =
    exists(patchesDir) && readdirSync(patchesDir).some((f) => f.endsWith(".patch"));

  const snapshot: StackSnapshot = {
    exo: {
      commit,
      pin,
      bind: proc?.bind ?? "127.0.0.1:9810",
      serve_flags: proc?.flags ?? [],
    },
    compose: { ports: compose.ports, network_modes: compose.networkModes },
    listeners,
    env: { files: envFiles, process: Object.keys(o.env), compose: compose.envVars },
    vault: { shared: false, identities: 1, secrets: [] },
    agents,
    environments,
    allowlists,
    mcp_servers: mcp,
    mode_a: {
      deny_list: [...settings.permissions.deny],
      bypass_disabled:
        settings.permissions.defaultMode === "default" &&
        settings.permissions.disableBypassPermissionsMode === "disable",
      // The launcher starts claude with the thread's worktree as its working directory (harnesses/claude-host).
      mount: "worktree",
    },
    claude,
    // Mode B is reported unsupported until token substitution is verified on a SmolVM or Firecracker host (V-9).
    mode_b: { provider: null, substitution_verified: false },
    cursor: {},
    meter: { lag_seconds: lag },
    permissions: {
      token_mode: tokenMode,
      state_dir_mode: stateMode,
      dashboard_token_mode: dashboardTokenMode,
    },
    price_table: { retrieved_at: rates.retrieved_at, now: now.toISOString().slice(0, 10) },
    submodule: { dirty, patches_recorded: patchesRecorded },
    workflows: workflowFacts(o.root),
    mcp_clients: clientConfigs(o.root),
    dashboard_only_tools: dashboardOnly,
    unavailable,
  };
  return stackSnapshotSchema.parse(snapshot);
}
