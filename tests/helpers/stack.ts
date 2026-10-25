// A whole offline stack for integration tests: the fake model, the Exo simulator with a few agents,
// and stackd on top of them, all on random loopback ports and temp directories.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildFakeModel } from "../../fake-model/src/server.ts";
import { createExoSim, type ExoSim } from "../../exo-sim/src/index.ts";
import { ExoClient } from "../../packages/exo-client/src/index.ts";
import { buildStackd, type StackdOptions } from "../../stackd/src/server.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls until `f` returns something truthy; the only way tests wait (no fixed sleeps). */
export async function until<T>(
  f: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export const AGENTS = [
  { slug: "repo-builder", harness: "../harnesses/claude-host/harness.ts" },
  { slug: "repo-builder-b", harness: "../harnesses/claude-sandboxed/claude-code-harness.ts" },
  { slug: "reviewer-cursor", harness: "cursor" },
  { slug: "local-harness", harness: "../harnesses/local-shim/harness.ts" },
];

export interface StackOptions {
  stepDelayMs?: number;
  ledgerPath?: string;
  /** Extra options for stackd (allowed workspace roots, clock, limits). */
  stackd?: Partial<StackdOptions>;
  /** Reuse a state directory, for restart tests. */
  stateDir?: string;
  exoDataDir?: string;
  modelUrl?: string;
}

export async function startStack(opts: StackOptions = {}) {
  const cleanups: Array<() => Promise<void> | void> = [];
  const dir = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };

  let modelUrl = opts.modelUrl;
  if (!modelUrl) {
    const model = await buildFakeModel();
    await model.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => model.close());
    modelUrl = `http://127.0.0.1:${(model.server.address() as AddressInfo).port}`;
  }

  const exoDataDir = opts.exoDataDir ?? dir("exo-sim-");
  const sim: ExoSim = await createExoSim({
    dataDir: exoDataDir,
    modelUrl,
    stepDelayMs: opts.stepDelayMs,
    ledgerPath: opts.ledgerPath,
    pollMs: 10,
  });
  await sim.app.listen({ host: "127.0.0.1", port: 0 });
  const exoUrl = `http://127.0.0.1:${(sim.app.server.address() as AddressInfo).port}/exo`;
  let simClosed = false;
  const closeSim = async () => {
    if (simClosed) return;
    simClosed = true;
    await sim.close();
  };
  cleanups.push(closeSim);

  const exo = new ExoClient({ baseUrl: exoUrl, retries: 0 });
  const existing = new Set((await exo.listAgents()).map((a) => a.slug));
  for (const a of AGENTS) {
    if (!existing.has(a.slug)) {
      await exo.createManagedAgent({ slug: a.slug, definition: { harness: a.harness } });
    }
  }

  const stateDir = opts.stateDir ?? dir("stackd-state-");
  const stackd = await buildStackd({ stateDir, exoUrl, exoClient: { retries: 0 }, ...opts.stackd });
  await stackd.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (stackd.app.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  let stackdClosed = false;
  const closeStackd = async () => {
    if (stackdClosed) return;
    stackdClosed = true;
    await stackd.close();
  };
  cleanups.push(closeStackd);

  /** One authenticated call to stackd; returns status, parsed body and headers. */
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${stackd.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON (an SSE stream or a plain error) */
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: bodies are schemaless
    return { status: res.status, body: parsed as any, headers: res.headers };
  };

  return {
    url,
    exoUrl,
    stateDir,
    token: stackd.token,
    stackd,
    sim,
    exo,
    call,
    /** Stops Exo (the simulator) while stackd keeps running, to test "Exo down". */
    stopExo: closeSim,
    stopStackd: closeStackd,
    dir,
    async stop() {
      for (const c of cleanups.splice(0).reverse()) await c();
    },
  };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

/** A git repository with one commit, for worktree tests. */
export function makeRepo(parent: string, name = "repo"): string {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH,
        HOME: parent,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return repo;
}
