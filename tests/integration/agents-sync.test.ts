/* eslint-disable @typescript-eslint/no-explicit-any -- recorded request bodies are schemaless here */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExoClient } from "../../packages/exo-client/src/index.ts";
import { json, startStub } from "../../packages/exo-client/test/stub.ts";
import {
  collectDefinitions,
  managedAgentBody,
  syncAgents,
} from "../../cli/src/commands/agents-sync.ts";

const root = join(import.meta.dirname, "..", "..");
const CATALOGUE = [
  "dual-review",
  "local-harness",
  "ops-slack",
  "repo-builder",
  "repo-builder-b",
  "researcher",
  "reviewer-cursor",
];

const stubs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

/** An Exo double with just the agent endpoints: it stores what it is sent and assigns ids. */
async function exoDouble(opts: { failCreateFor?: string } = {}) {
  const agents = new Map<string, { id: string; slug: string; body: any }>();
  let n = 0;
  const writes: string[] = [];
  const stub = await startStub((call, res) => {
    if (call.method === "GET" && call.path === "/exo/agent") {
      return json(res, {
        agents: [...agents.values()].map((a) => ({ id: a.id, slug: a.slug, name: a.slug })),
      });
    }
    const body = call.body as any;
    if (call.method === "POST" && call.path === "/exo/agent/managed") {
      writes.push(`POST ${body.slug}`);
      if (body.slug === opts.failCreateFor) return json(res, { error: "rejected" }, 400);
      const id = `agent-${++n}`;
      agents.set(body.slug, { id, slug: body.slug, body });
      return json(res, { agent: { id, slug: body.slug } });
    }
    const put = /^\/exo\/agent\/([^/]+)\/definition$/.exec(call.path);
    if (call.method === "PUT" && put) {
      const found = [...agents.values()].find((a) => a.id === put[1]);
      if (!found) return json(res, { error: "unknown agent" }, 404);
      writes.push(`PUT ${found.slug}`);
      found.body = body;
      return json(res, { agent: { id: found.id, slug: found.slug } });
    }
    json(res, { error: "unexpected" }, 404);
  });
  stubs.push(stub);
  return {
    stub,
    agents,
    writes,
    client: new ExoClient({
      baseUrl: stub.baseUrl,
      sleep: async () => {},
      random: () => 0.5,
      retries: 1,
    }),
  };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "sync-"));
  for (const d of ["agents", "tools", "fixtures", "harnesses"])
    cpSync(join(root, d), join(dir, d), { recursive: true });
  return { dir, agentsDir: join(dir, "agents"), statePath: join(dir, "state", "agents-sync.json") };
}

describe("collectDefinitions", () => {
  it("returns the seven catalogue agents plus the generated Cursor fallback, sorted", () => {
    const defs = collectDefinitions(join(root, "agents"));
    expect(defs.map((d) => d.name)).toEqual([...CATALOGUE, "dual-review-cursor"].sort());
    for (const name of CATALOGUE) expect(defs.map((d) => d.name)).toContain(name);
  });

  it("lets a generated definition replace a hand-written one of the same name", () => {
    const w = workspace();
    writeFileSync(
      join(w.agentsDir, "generated", "ops-slack.md"),
      readFileSync(join(w.agentsDir, "ops-slack.md"), "utf8").replace(
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ),
    );
    const ops = collectDefinitions(w.agentsDir).filter((d) => d.name === "ops-slack");
    expect(ops).toHaveLength(1);
    expect((ops[0]!.front.model as any).name).toBe("claude-sonnet-5-5");
  });
});

describe("managedAgentBody", () => {
  it("carries the slug, the definition fields and the instructions, and nothing from the environment", () => {
    const def = collectDefinitions(join(root, "agents")).find((d) => d.name === "repo-builder")!;
    const body = managedAgentBody(def) as any;
    expect(body.slug).toBe("repo-builder");
    expect(body.definition.harness).toBe(join(root, "harnesses", "claude-host", "harness.ts"));
    expect(body.definition.tools).toEqual([
      join(root, "tools", "run-checks.ts"),
      join(root, "tools", "write-report.ts"),
    ]);
    expect(body.instructions).toContain("untrusted data");
    expect(JSON.stringify(body)).not.toMatch(/token|secret|password/i);
  });
});

describe("syncAgents (FR-2)", () => {
  it("creates every definition once and reports a second sync as unchanged", async () => {
    const w = workspace();
    const exo = await exoDouble();
    const first = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(first.errors).toEqual([]);
    expect(first.created.sort()).toEqual([...CATALOGUE, "dual-review-cursor"].sort());
    expect(first.updated).toEqual([]);
    expect(exo.writes).toHaveLength(8);

    exo.writes.length = 0;
    const second = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual([...CATALOGUE, "dual-review-cursor"].sort());
    for (const name of CATALOGUE) expect(second.unchanged).toContain(name);
    expect(exo.writes).toEqual([]); // no request that changes anything
  });

  it("updates only the definition that changed, through PUT on its id", async () => {
    const w = workspace();
    const exo = await exoDouble();
    await syncAgents({ client: exo.client, agentsDir: w.agentsDir, statePath: w.statePath });
    exo.writes.length = 0;
    const file = join(w.agentsDir, "ops-slack.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("claude-haiku-5-5", "claude-sonnet-5-5"),
    );
    const r = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(r.updated).toEqual(["ops-slack"]);
    expect(r.unchanged).toHaveLength(7);
    expect(exo.writes).toEqual(["PUT ops-slack"]);
    expect(exo.agents.get("ops-slack")!.body.definition.model.name).toBe("claude-sonnet-5-5");
  });

  it("creates again an agent that Exo no longer has (a fresh Exo), even though the state says it is current", async () => {
    const w = workspace();
    const exo = await exoDouble();
    await syncAgents({ client: exo.client, agentsDir: w.agentsDir, statePath: w.statePath });
    exo.agents.delete("researcher");
    exo.writes.length = 0;
    const r = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(r.created).toEqual(["researcher"]);
    expect(exo.writes).toEqual(["POST researcher"]);
  });

  it("without a state file, updates the agents Exo already has (PUT is idempotent) and rewrites the state", async () => {
    const w = workspace();
    const exo = await exoDouble();
    await syncAgents({ client: exo.client, agentsDir: w.agentsDir, statePath: w.statePath });
    rmSync(w.statePath);
    const r = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(r.created).toEqual([]);
    expect(r.updated).toHaveLength(8);
    const again = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(again.unchanged).toHaveLength(8);
  });

  it("--dry-run reports the plan and sends and stores nothing", async () => {
    const w = workspace();
    const exo = await exoDouble();
    const r = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
      dryRun: true,
    });
    expect(r.created).toHaveLength(8);
    expect(exo.writes).toEqual([]);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("keeps going when one definition is rejected, records only the successes, and reports the error", async () => {
    const w = workspace();
    const exo = await exoDouble({ failCreateFor: "researcher" });
    const r = await syncAgents({
      client: exo.client,
      agentsDir: w.agentsDir,
      statePath: w.statePath,
    });
    expect(r.created).toHaveLength(7);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ name: "researcher" });
    expect(r.errors[0]!.message).toMatch(/400/);
    const state = JSON.parse(readFileSync(w.statePath, "utf8"));
    expect(Object.keys(state.agents)).not.toContain("researcher");
    expect(Object.keys(state.agents)).toHaveLength(7);
  });

  it("refuses to send anything when a definition does not lint", async () => {
    const w = workspace();
    const exo = await exoDouble();
    const file = join(w.agentsDir, "researcher.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("harness:", "bogus_key: 1\nharness:"));
    await expect(
      syncAgents({ client: exo.client, agentsDir: w.agentsDir, statePath: w.statePath }),
    ).rejects.toThrow(/lint|unknown-key/i);
    expect(exo.writes).toEqual([]);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("fails clearly, leaving the state untouched, when Exo is unreachable", async () => {
    const w = workspace();
    const exo = await exoDouble();
    const url = exo.stub.baseUrl;
    await exo.stub.close();
    stubs.length = 0;
    const client = new ExoClient({
      baseUrl: url,
      sleep: async () => {},
      random: () => 0.5,
      retries: 1,
    });
    await expect(
      syncAgents({ client, agentsDir: w.agentsDir, statePath: w.statePath }),
    ).rejects.toThrow(/unavailable|reach/i);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("writes a state file that holds hashes and ids only", async () => {
    const w = workspace();
    const exo = await exoDouble();
    await syncAgents({ client: exo.client, agentsDir: w.agentsDir, statePath: w.statePath });
    const state = JSON.parse(readFileSync(w.statePath, "utf8"));
    expect(state.version).toBe(1);
    expect(state.agents["repo-builder"]).toEqual({
      id: expect.stringMatching(/^agent-/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(state)).not.toContain("untrusted");
  });
});

describe("exos agents sync", () => {
  const cli = join(root, "cli", "src", "main.ts");
  // Asynchronous on purpose: the Exo double lives in this process and must keep answering while
  // the CLI runs, which a blocking spawnSync would prevent.
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", cli, "agents", "sync", ...args], {
        cwd: root,
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (status) => resolve({ status, out, err }));
    });

  it("syncs against an Exo URL, prints the counts, and exits 0; a second run says unchanged", async () => {
    const w = workspace();
    const exo = await exoDouble();
    const env = { EXOS_EXO_URL: exo.stub.baseUrl, EXOS_STATE_DIR: join(w.dir, "state") };
    const first = await run(["--agents", w.agentsDir], env);
    expect(first.status, first.err).toBe(0);
    expect(first.out).toMatch(/8 created, 0 updated, 0 unchanged/);
    const second = await run(["--agents", w.agentsDir], env);
    expect(second.status, second.err).toBe(0);
    expect(second.out).toMatch(/0 created, 0 updated, 8 unchanged/);
  });

  it("exits 1 when Exo is unreachable and 2 for a missing agents directory", async () => {
    const down = await run([], {
      EXOS_EXO_URL: "http://127.0.0.1:1/exo",
      EXOS_STATE_DIR: mkdtempSync(join(tmpdir(), "s-")),
    });
    expect(down.status).toBe(1);
    expect(down.err).toMatch(/unavailable|reach/i);
    expect((await run(["--agents", "/nonexistent-agents"], {})).status).toBe(2);
  });
});
