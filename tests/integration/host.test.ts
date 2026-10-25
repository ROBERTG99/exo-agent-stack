// T-33: `exos host up|down|status` start real processes: the offline Exo simulator, the fake model,
// stackd and the bridge, on random loopback ports.
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  childEnv,
  hostDown,
  hostStatus,
  hostUp,
  loadHostConfig,
  serviceDefs,
  type HostConfig,
} from "../../cli/src/commands/host.ts";

const repo = join(import.meta.dirname, "..", "..");
const KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function config(): Promise<HostConfig> {
  const stateDir = mkdtempSync(join(tmpdir(), "host-state-"));
  const cfg = loadHostConfig(
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      EXOS_STATE_DIR: stateDir,
      EXOS_EXO_PORT: String(await freePort()),
      EXOS_BRIDGE_PORT: String(await freePort()),
      EXOS_STACKD_PORT: String(await freePort()),
      EXOS_FAKE_MODEL_PORT: String(await freePort()),
      EXOS_EXO_BIN: join(stateDir, "no-such-exo"), // not built: the simulator stands in
    },
    repo,
  );
  cleanups.push(async () => {
    await hostDown(cfg, { out: () => undefined });
    rmSync(stateDir, { recursive: true, force: true });
  });
  return cfg;
}

const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) },
  };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("exos host up, status and down", () => {
  it("starts the stack, reports it healthy, is idempotent, and stops it completely", async () => {
    const cfg = await config();
    const s = sink();
    expect(await hostUp(cfg, s.io, { timeoutMs: 60_000 })).toBe(0);
    expect(s.err.join("\n")).toContain("simulator");
    expect(s.out.filter((l) => l.includes("started"))).toHaveLength(4);

    const rows = await hostStatus(cfg);
    expect(rows.map((r) => [r.name, r.healthy])).toEqual([
      ["fake-model", true],
      ["exo", true],
      ["stackd", true],
      ["bridge", true],
    ]);
    expect(rows.filter((r) => r.simulated).map((r) => r.name)).toEqual(["fake-model", "exo"]);

    // the services work together: stackd sees Exo, the bridge answers
    const health = await (await fetch(`http://127.0.0.1:${cfg.ports.stackd}/api/v1/health`)).json();
    expect(health).toMatchObject({ status: "ok", exo: { reachable: true } });
    expect((await fetch(`http://127.0.0.1:${cfg.ports.bridge}/healthz`)).status).toBe(200);

    const again = sink();
    expect(await hostUp(cfg, again.io, { timeoutMs: 60_000 })).toBe(0);
    expect(again.out.filter((l) => l.includes("already running"))).toHaveLength(4);

    const pids = rows.map((r) => r.pid!);
    const down = sink();
    expect(await hostDown(cfg, down.io)).toBe(0);
    expect(down.out.filter((l) => l.endsWith("stopped"))).toHaveLength(4);
    expect(pids.some(alive)).toBe(false);
    expect((await hostStatus(cfg)).every((r) => !r.running)).toBe(true);
    for (const port of Object.values(cfg.ports)) {
      await expect(
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toBeTruthy();
    }
  }, 180_000);

  it("keeps logs and pid files in the state directory with owner-only permissions", async () => {
    const cfg = await config();
    expect(await hostUp(cfg, sink().io, { timeoutMs: 60_000 })).toBe(0);
    for (const name of ["exo", "stackd", "bridge", "fake-model"]) {
      expect(statSync(join(cfg.stateDir, "run", `${name}.pid`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(cfg.stateDir, "logs", `${name}.log`)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(cfg.stateDir, "logs", "stackd.log"), "utf8")).toContain(
      '"service":"stackd"',
    );
    expect(statSync(join(cfg.stateDir, "local-token")).mode & 0o777).toBe(0o600);
  }, 120_000);

  it("brings back a service that was killed, leaving the others and the state alone", async () => {
    const cfg = await config();
    expect(await hostUp(cfg, sink().io, { timeoutMs: 60_000 })).toBe(0);
    const before = await hostStatus(cfg);
    const stackd = before.find((r) => r.name === "stackd")!;
    const token = readFileSync(join(cfg.stateDir, "local-token"), "utf8");
    process.kill(stackd.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect((await hostStatus(cfg)).find((r) => r.name === "stackd")!.healthy).toBe(false);

    const s = sink();
    expect(await hostUp(cfg, s.io, { timeoutMs: 60_000 })).toBe(0);
    expect(s.out.filter((l) => l.includes("already running")).length).toBe(3);
    expect(s.out.some((l) => l.startsWith("stackd: started"))).toBe(true);
    const after = await hostStatus(cfg);
    expect(after.find((r) => r.name === "stackd")!.pid).not.toBe(stackd.pid);
    expect(after.find((r) => r.name === "exo")!.pid).toBe(
      before.find((r) => r.name === "exo")!.pid,
    );
    expect(readFileSync(join(cfg.stateDir, "local-token"), "utf8")).toBe(token);
    expect(existsSync(join(cfg.stateDir, "stack.db"))).toBe(true);
  }, 180_000);

  it("refuses to start over a port that something else uses, and leaves nothing running", async () => {
    const cfg = await config();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(cfg.ports.exo, "127.0.0.1", r));
    cleanups.push(() => void blocker.close());
    const s = sink();
    expect(await hostUp(cfg, s.io, { timeoutMs: 60_000 })).toBe(1);
    expect(s.err.join("\n")).toContain(`port ${cfg.ports.exo} is already in use`);
    expect((await hostStatus(cfg)).every((r) => !r.running)).toBe(true);
  }, 120_000);

  it("reports a service that dies on start, with the end of its log", async () => {
    const cfg = await config();
    const bad: HostConfig = { ...cfg, repo: mkdtempSync(join(tmpdir(), "empty-repo-")) }; // nothing to run there
    cleanups.push(() => rmSync(bad.repo, { recursive: true, force: true }));
    const s = sink();
    expect(await hostUp(bad, s.io, { timeoutMs: 20_000 })).toBe(1);
    expect(s.err.join("\n")).toMatch(/did not become healthy/);
    expect((await hostStatus(bad)).every((r) => !r.running)).toBe(true);
  }, 60_000);

  it("says so when nothing is running", async () => {
    const cfg = await config();
    const s = sink();
    expect(await hostDown(cfg, s.io)).toBe(0);
    expect(s.out).toEqual(["nothing was running"]);
  });
});

describe("what a service is given", () => {
  it("passes a few system variables and EXOS_ settings, and no API key of the parent", () => {
    const env = childEnv(
      {
        PATH: "/bin",
        HOME: "/h",
        [KEY_VAR]: "x",
        OPENAI_API_KEY: "y",
        EXOS_STATE_DIR: "/s",
        SECRET_THING: "z",
        TERM: "xterm",
      },
      { EXOS_LISTEN_HOST: "127.0.0.1" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      TERM: "xterm",
      EXOS_STATE_DIR: "/s",
      EXOS_LISTEN_HOST: "127.0.0.1",
    });
  });

  it("starts the services in dependency order, each on loopback with the others' addresses", async () => {
    const cfg = await config();
    const defs = serviceDefs(cfg);
    expect(defs.map((d) => d.name)).toEqual(["fake-model", "exo", "stackd", "bridge"]);
    const stackd = defs.find((d) => d.name === "stackd")!;
    expect(stackd.env.EXOS_EXO_URL).toBe(`http://127.0.0.1:${cfg.ports.exo}/exo`);
    expect(defs.find((d) => d.name === "bridge")!.env.EXOS_STACKD_URL).toBe(
      `http://127.0.0.1:${cfg.ports.stackd}`,
    );
    for (const d of defs) {
      expect(d.healthUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(d.env.EXOS_LISTEN_HOST).toBe("127.0.0.1");
      expect(Object.keys(d.env).some((k) => k === KEY_VAR)).toBe(false);
    }
  });

  it("uses the real Exo with a loopback bind when its binary exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-exo-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, "exo");
    await import("node:fs").then((fs) => fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 }));
    const cfg = loadHostConfig(
      { PATH: process.env.PATH, EXOS_STATE_DIR: dir, EXOS_EXO_BIN: bin },
      repo,
    );
    const defs = serviceDefs(cfg);
    expect(defs.map((d) => d.name)).toEqual(["exo", "stackd", "bridge"]);
    expect(defs[0]).toMatchObject({ command: bin, simulated: false });
    expect(defs[0]!.args).toEqual([
      "--root",
      join(dir, "exo"),
      "run",
      "--serve",
      "--bind",
      "127.0.0.1:9810",
    ]);
  });
});
