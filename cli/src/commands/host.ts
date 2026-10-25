// `exos host`: run the stack natively, without Docker (BUILD.md §16, FR-10).
//
//   exos host up        start Exo (or its offline simulator), stackd and the bridge, wait until healthy
//   exos host down      stop them
//   exos host status    which are running and healthy
//   exos host render    write launchd or systemd unit files that keep them running across crashes
//
// Every service listens on 127.0.0.1 only; children get an allowlisted environment, so no API-key
// variable of the parent reaches them; nothing here signs in or installs anything: `render` writes
// files and prints the commands for you to run.
import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { parsePort, resolveListenHost } from "@exos/common";
import type { CommandIo } from "../main.ts";

export interface HostConfig {
  repo: string;
  stateDir: string;
  host: string;
  ports: { exo: number; bridge: number; stackd: number; fakeModel: number };
  node: string;
  /** The built Exo binary, if there is one; otherwise the simulator stands in. */
  exoBin: string | undefined;
  env: Record<string, string | undefined>;
}

export function loadHostConfig(env: Record<string, string | undefined>, repo: string): HostConfig {
  // Loopback only; "container" is refused because this is not a container.
  const host = resolveListenHost(env, () => false);
  const exoBin = env.EXOS_EXO_BIN || path.join(repo, "vendor/exo/target/release/exo");
  return {
    repo,
    stateDir: path.resolve(repo, env.EXOS_STATE_DIR || ".exos-state/host"),
    host,
    ports: {
      exo: parsePort(env.EXOS_EXO_PORT, 9810),
      bridge: parsePort(env.EXOS_BRIDGE_PORT, 9811),
      stackd: parsePort(env.EXOS_STACKD_PORT, 9812),
      fakeModel: parsePort(env.EXOS_FAKE_MODEL_PORT, 9840),
    },
    node: process.execPath,
    exoBin: existsSync(exoBin) ? exoBin : undefined,
    env,
  };
}

export interface ServiceDef {
  name: string;
  /** What starts it, for the pid file and for checking that a pid is still ours. */
  command: string;
  args: string[];
  env: Record<string, string>;
  healthUrl: string;
  port: number;
  /** True for the offline stand-ins, which `status` labels as such. */
  simulated: boolean;
}

const PASS_THROUGH = ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "SHELL", "USER"];

/** The environment a service gets: a few system variables and the stack's own EXOS_ settings. */
export function childEnv(
  parent: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (parent[k] !== undefined) out[k] = parent[k]!;
  for (const [k, v] of Object.entries(parent))
    if (k.startsWith("EXOS_") && v !== undefined) out[k] = v;
  return { ...out, ...extra };
}

export function serviceDefs(cfg: HostConfig): ServiceDef[] {
  const url = (port: number, p: string) =>
    `http://${cfg.host === "localhost" ? "127.0.0.1" : cfg.host}:${port}${p}`;
  const exoUrl = url(cfg.ports.exo, "/exo");
  const stackdUrl = url(cfg.ports.stackd, "");
  const node = (entry: string) => ({ command: cfg.node, args: ["--import", "tsx", entry] });
  const base = {
    EXOS_LISTEN_HOST: cfg.host,
    EXOS_STATE_DIR: cfg.stateDir,
    EXOS_EXO_PORT: String(cfg.ports.exo),
    EXOS_BRIDGE_PORT: String(cfg.ports.bridge),
    EXOS_STACKD_PORT: String(cfg.ports.stackd),
    EXOS_FAKE_MODEL_PORT: String(cfg.ports.fakeModel),
  };
  const defs: ServiceDef[] = [];
  if (cfg.exoBin) {
    defs.push({
      name: "exo",
      command: cfg.exoBin,
      args: [
        "--root",
        path.join(cfg.stateDir, "exo"),
        "run",
        "--serve",
        "--bind",
        `${cfg.host}:${cfg.ports.exo}`,
      ],
      env: childEnv(cfg.env, base),
      healthUrl: url(cfg.ports.exo, "/exo/agent"),
      port: cfg.ports.exo,
      simulated: false,
    });
  } else {
    defs.push({
      name: "fake-model",
      ...node("fake-model/src/server.ts"),
      env: childEnv(cfg.env, base),
      healthUrl: url(cfg.ports.fakeModel, "/healthz"),
      port: cfg.ports.fakeModel,
      simulated: true,
    });
    defs.push({
      name: "exo",
      ...node("exo-sim/src/main.ts"),
      env: childEnv(cfg.env, {
        ...base,
        EXO_SIM_DATA_DIR: path.join(cfg.stateDir, "exo-sim"),
        EXO_SIM_MODEL_URL: url(cfg.ports.fakeModel, ""),
      }),
      healthUrl: url(cfg.ports.exo, "/exo/agent"),
      port: cfg.ports.exo,
      simulated: true,
    });
  }
  defs.push({
    name: "stackd",
    ...node("stackd/src/server.ts"),
    env: childEnv(cfg.env, { ...base, EXOS_EXO_URL: exoUrl }),
    healthUrl: url(cfg.ports.stackd, "/api/v1/health"),
    port: cfg.ports.stackd,
    simulated: false,
  });
  defs.push({
    name: "bridge",
    ...node("bridge/src/server.ts"),
    env: childEnv(cfg.env, { ...base, EXOS_STACKD_URL: stackdUrl }),
    healthUrl: url(cfg.ports.bridge, "/healthz"),
    port: cfg.ports.bridge,
    simulated: false,
  });
  return defs;
}

// --- processes ----------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pidFile = (cfg: HostConfig, name: string) => path.join(cfg.stateDir, "run", `${name}.pid`);
const logFile = (cfg: HostConfig, name: string) => path.join(cfg.stateDir, "logs", `${name}.log`);

interface PidRecord {
  pid: number;
  started_at: string;
  command: string;
  /** What the service was started with; a record without it cannot be matched and is not trusted. */
  args?: string[];
}

function readPid(cfg: HostConfig, name: string): PidRecord | undefined {
  try {
    return JSON.parse(readFileSync(pidFile(cfg, name), "utf8")) as PidRecord;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only if `pid` is running the command line we recorded: the program and every argument (so the
 * script of the service, not just any node process). A pid that was reused after a reboot, a record
 * without arguments or a `ps` that fails are not ours: `down` signals nothing it cannot identify.
 */
function isOurs(rec: PidRecord): boolean {
  if (!alive(rec.pid) || !Array.isArray(rec.args)) return false;
  try {
    const cmd = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(rec.pid)], {
      encoding: "utf8",
    }).trim();
    return cmd.includes(path.basename(rec.command)) && rec.args.every((a) => cmd.includes(a));
  } catch {
    return false;
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
  });
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

export interface UpOptions {
  timeoutMs?: number;
}

export async function hostUp(
  cfg: HostConfig,
  io: Pick<CommandIo, "out" | "err">,
  opts: UpOptions = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  mkdirSync(path.join(cfg.stateDir, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(cfg.stateDir, "logs"), { recursive: true, mode: 0o700 });
  const defs = serviceDefs(cfg);
  if (defs.some((d) => d.simulated)) {
    io.err(
      "note: the Exo binary is not built (docs/KNOWN_LIMITATIONS.md), so the offline simulator and the fake model stand in for Exo and the model",
    );
  }
  const started: ServiceDef[] = [];
  for (const def of defs) {
    const known = readPid(cfg, def.name);
    if (known && isOurs(known) && (await healthy(def.healthUrl))) {
      io.out(`${def.name}: already running (pid ${known.pid})`);
      continue;
    }
    if (known && !isOurs(known)) rmSync(pidFile(cfg, def.name), { force: true });
    if (await portInUse(cfg.host, def.port)) {
      io.err(
        `${def.name}: port ${def.port} is already in use by something else; stop it or change the port`,
      );
      await stopAll(cfg, started.reverse(), io);
      return 1;
    }
    const log = openSync(logFile(cfg, def.name), "a", 0o600);
    const child = spawn(def.command, def.args, {
      cwd: cfg.repo,
      env: def.env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    if (child.pid === undefined) {
      io.err(`${def.name}: could not start (${def.command})`);
      await stopAll(cfg, started.reverse(), io);
      return 1;
    }
    writeFileSync(
      pidFile(cfg, def.name),
      JSON.stringify({
        pid: child.pid,
        started_at: new Date().toISOString(),
        command: def.command,
        args: def.args,
      } satisfies PidRecord),
      { mode: 0o600 },
    );
    started.push(def);

    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      if (!alive(child.pid)) break;
      if (await healthy(def.healthUrl)) {
        ok = true;
        break;
      }
      await sleep(100);
    }
    if (!ok) {
      io.err(
        `${def.name}: did not become healthy at ${def.healthUrl}. Last log lines (${logFile(cfg, def.name)}):`,
      );
      io.err(tail(logFile(cfg, def.name)));
      await stopAll(cfg, started.reverse(), io);
      return 1;
    }
    io.out(
      `${def.name}: started (pid ${child.pid}) on ${cfg.host}:${def.port}${def.simulated ? " [simulator]" : ""}`,
    );
  }
  io.out(`stack is up. State: ${cfg.stateDir}. Stop with: exos host down`);
  return 0;
}

async function stopOne(cfg: HostConfig, name: string, io: Pick<CommandIo, "out">): Promise<void> {
  const rec = readPid(cfg, name);
  if (!rec) return;
  rmSync(pidFile(cfg, name), { force: true });
  if (!isOurs(rec)) return;
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 50 && alive(rec.pid); i++) await sleep(100);
  if (alive(rec.pid)) {
    try {
      process.kill(rec.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 20 && alive(rec.pid); i++) await sleep(50);
  }
  io.out(`${name}: stopped`);
}

async function stopAll(
  cfg: HostConfig,
  defs: ServiceDef[],
  io: Pick<CommandIo, "out">,
): Promise<void> {
  for (const d of defs) await stopOne(cfg, d.name, io);
}

export async function hostDown(cfg: HostConfig, io: Pick<CommandIo, "out">): Promise<number> {
  const known = existsSync(path.join(cfg.stateDir, "run"))
    ? readdirSync(path.join(cfg.stateDir, "run"))
        .filter((f) => f.endsWith(".pid"))
        .map((f) => f.slice(0, -4))
    : [];
  const order = ["bridge", "stackd", "exo", "fake-model"];
  for (const name of [
    ...order.filter((n) => known.includes(n)),
    ...known.filter((n) => !order.includes(n)),
  ]) {
    await stopOne(cfg, name, io);
  }
  if (known.length === 0) io.out("nothing was running");
  return 0;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  healthy: boolean;
  pid: number | null;
  port: number;
  simulated: boolean;
}

export async function hostStatus(cfg: HostConfig): Promise<ServiceStatus[]> {
  const out: ServiceStatus[] = [];
  for (const def of serviceDefs(cfg)) {
    const rec = readPid(cfg, def.name);
    const running = !!rec && isOurs(rec);
    out.push({
      name: def.name,
      running,
      healthy: running && (await healthy(def.healthUrl)),
      pid: running ? rec!.pid : null,
      port: def.port,
      simulated: def.simulated,
    });
  }
  return out;
}

// --- unit files ---------------------------------------------------------------------------------

export interface RenderOptions {
  platform: "launchd" | "systemd";
  repo: string;
  stateDir: string;
  node: string;
  home: string;
  path: string;
  workspaceRoots: string;
  exoBin: string | undefined;
  /** Where deploy/<platform> is read from (default: the repository the units will run). */
  templatesRoot?: string;
}

export interface Rendered {
  files: Array<{ name: string; content: string }>;
  notes: string[];
}

const XML = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Fills the templates in deploy/<platform>. Refuses values a unit file cannot hold safely. */
export function renderUnits(o: RenderOptions): Rendered {
  const absolute = {
    repo: o.repo,
    "state dir": o.stateDir,
    node: o.node,
    home: o.home,
    ...(o.exoBin ? { "Exo binary": o.exoBin } : {}),
  };
  for (const [what, value] of Object.entries(absolute)) {
    if (!path.isAbsolute(value)) throw new Error(`the ${what} must be an absolute path`);
    if (/[\s%$"'\\<>&]/.test(value))
      throw new Error(
        `the ${what} (${value}) contains a character a unit file cannot hold safely: use a path without spaces or special characters`,
      );
  }
  for (const root of o.workspaceRoots.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(root) || /[\s%$"'\\<>&]/.test(root)) {
      throw new Error(
        `workspace root "${root}" must be an absolute path without spaces or special characters`,
      );
    }
  }
  const dir = path.join(o.templatesRoot ?? o.repo, "deploy", o.platform);
  const suffix = o.platform === "launchd" ? ".plist.template" : ".service.template";
  const notes: string[] = [];
  const files: Rendered["files"] = [];
  const escape = o.platform === "launchd" ? XML : (s: string) => s;
  const values: Record<string, string> = {
    "@NODE@": o.node,
    "@REPO@": o.repo,
    "@STATE_DIR@": o.stateDir,
    "@HOME@": o.home,
    "@PATH@": o.path,
    "@WORKSPACE_ROOTS@": o.workspaceRoots,
    "@EXO_BIN@": o.exoBin ?? "",
  };
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()) {
    const name = file.slice(0, -suffix.length);
    if (name.endsWith("exo") && !o.exoBin) {
      notes.push(
        "Exo is not built (T-02 is blocked), so no Exo unit was written; the stack runs against the simulator with `exos host up`.",
      );
      continue;
    }
    let text = readFileSync(path.join(dir, file), "utf8");
    for (const [key, value] of Object.entries(values)) text = text.split(key).join(escape(value));
    const left = /@[A-Z_]+@/.exec(text);
    if (left) throw new Error(`${file}: placeholder ${left[0]} was not filled`);
    files.push({
      name: o.platform === "launchd" ? `${name}.plist` : `${name}.service`,
      content: text,
    });
  }
  return { files, notes };
}

// --- the command ---------------------------------------------------------------------------------

function option(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function hostCommand(args: string[], io: CommandIo): Promise<number> {
  const [sub, ...rest] = args;
  const repo = path.resolve(option(rest, "--repo") ?? io.env.EXOS_REPO_ROOT ?? ".");
  try {
    switch (sub) {
      case "up":
        return await hostUp(loadHostConfig(io.env, repo), io);
      case "down":
        return await hostDown(loadHostConfig(io.env, repo), io);
      case "status": {
        const rows = await hostStatus(loadHostConfig(io.env, repo));
        if (rest.includes("--json")) io.out(JSON.stringify(rows, null, 2));
        else
          for (const r of rows)
            io.out(
              `${r.name.padEnd(11)} ${r.running ? (r.healthy ? "healthy" : "running, not healthy") : "stopped"}${r.pid ? ` (pid ${r.pid})` : ""} port ${r.port}${r.simulated ? " [simulator]" : ""}`,
            );
        return rows.every((r) => r.healthy) ? 0 : 1;
      }
      case "render": {
        const platform = option(rest, "--platform");
        if (platform !== "launchd" && platform !== "systemd") {
          io.err(
            "usage: exos host render --platform launchd|systemd --out <dir> [--state-dir <dir>] [--workspace-roots <a:b>]",
          );
          return 2;
        }
        const cfg = loadHostConfig(io.env, repo);
        const out = path.resolve(option(rest, "--out") ?? path.join(cfg.stateDir, "units"));
        const rendered = renderUnits({
          platform,
          repo,
          stateDir: path.resolve(option(rest, "--state-dir") ?? cfg.stateDir),
          node: process.execPath,
          home: io.env.HOME ?? "/",
          path: io.env.PATH ?? "/usr/bin:/bin",
          workspaceRoots:
            option(rest, "--workspace-roots") ?? io.env.EXOS_ALLOWED_WORKSPACE_ROOTS ?? "",
          exoBin: cfg.exoBin,
        });
        mkdirSync(out, { recursive: true });
        for (const f of rendered.files) {
          writeFileSync(path.join(out, f.name), f.content, { mode: 0o644 });
          io.out(`wrote ${path.join(out, f.name)}`);
        }
        for (const n of rendered.notes) io.err(`note: ${n}`);
        io.out(
          platform === "launchd"
            ? `To install (you run these): cp ${out}/com.exos.*.plist ~/Library/LaunchAgents/ && for f in ~/Library/LaunchAgents/com.exos.*.plist; do launchctl bootstrap gui/$(id -u) "$f"; done`
            : `To install (you run these): mkdir -p ~/.config/systemd/user && cp ${out}/exos-*.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now exos-stackd.service exos-bridge.service`,
        );
        return 0;
      }
      default:
        io.err("usage: exos host <up|down|status|render> [options]");
        return 2;
    }
  } catch (err) {
    io.err(`exos host: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
