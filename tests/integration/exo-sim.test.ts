// The Exo simulator is the offline stand-in for Exo: these tests drive it through the same
// ExoClient that stackd uses, against the real fake model server, and check the durability
// properties the stack relies on (exactly-once tool calls and pending decisions across a kill).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ExoClient } from "../../packages/exo-client/src/index.ts";
import { buildFakeModel } from "../../fake-model/src/server.ts";
import { createExoSim } from "../../exo-sim/src/index.ts";
import { ledgerStats } from "../../harnesses/scripted/ledger.ts";

const root = join(import.meta.dirname, "..", "..");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Thread objects come back as loose records from the client. */
const idOf = (o: Record<string, unknown> | undefined): string => String(o?.id);

type Ev = { id: string; type: string; [k: string]: unknown };

async function until<T>(
  f: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function fakeModel(): Promise<string> {
  const app = await buildFakeModel();
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "exo-sim-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A started simulator plus helpers bound to it. */
async function start(
  opts: { dataDir?: string; modelUrl?: string; stepDelayMs?: number; ledgerPath?: string } = {},
) {
  const dataDir = opts.dataDir ?? tmp();
  const sim = await createExoSim({
    dataDir,
    modelUrl: opts.modelUrl ?? (await fakeModel()),
    stepDelayMs: opts.stepDelayMs,
    ledgerPath: opts.ledgerPath,
    pollMs: 10,
  });
  await sim.app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(sim.app.server.address() as AddressInfo).port}/exo`;
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await sim.close();
  });
  return {
    sim,
    dataDir,
    url,
    client: new ExoClient({ baseUrl: url, retries: 0 }),
    stop: async () => {
      closed = true;
      await sim.close();
    },
    events: async (agent: string, thread: string, query = ""): Promise<Ev[]> => {
      const res = await fetch(`${url}/agent/${agent}/thread/${thread}/event${query}`);
      return ((await res.json()) as { events: Ev[] }).events;
    },
  };
}
type Started = Awaited<ReturnType<typeof start>>;

/** Creates an agent and a thread and submits one turn; returns the ids. */
async function turn(
  s: Started,
  input: string,
  extra: { frontend?: boolean; auto?: string[]; slug?: string } = {},
) {
  let agent = (await s.client.listAgents({ slug: "tester" }))[0];
  if (!agent) {
    await s.client.createManagedAgent({ slug: "tester", definition: { harness: "scripted" } });
    agent = (await s.client.listAgents({ slug: "tester" }))[0]!;
  }
  const t = await s.client.createThread(agent.id, { vaults: [], thread_slug: extra.slug ?? "t1" });
  const submitted = await s.client.submitTurn(agent.id, idOf(t.thread), {
    input,
    frontend_tools: extra.frontend ? [{ name: "ask_user" }] : [],
    auto_approve_tools: extra.auto,
  });
  const turnObj = submitted.turn as { id: string; session_id: string };
  return { agent: agent.id, thread: idOf(t.thread), turn: turnObj.id, session: turnObj.session_id };
}

const ended = (s: Started, ids: { agent: string; thread: string; turn: string }) =>
  until(
    async () =>
      (await s.events(ids.agent, ids.thread, `?turn_id=${ids.turn}&event_type=turn_ended`))[0],
    "turn_ended",
  );

describe("exo-sim: agents and threads", () => {
  it("creates, lists, filters and rejects duplicate agents", async () => {
    const s = await start();
    await s.client.createManagedAgent({ slug: "alpha", definition: {} });
    await s.client.createManagedAgent({ slug: "beta", definition: {} });
    expect((await s.client.listAgents()).map((a) => a.slug).sort()).toEqual(["alpha", "beta"]);
    expect((await s.client.listAgents({ slug: "beta" })).map((a) => a.slug)).toEqual(["beta"]);
    await expect(s.client.createManagedAgent({ slug: "alpha", definition: {} })).rejects.toThrow();
    const alpha = (await s.client.listAgents({ slug: "alpha" }))[0]!;
    await s.client.updateAgentDefinition(alpha.id, { definition: { harness: "x" } });
    expect(await s.client.agentDoctor(alpha.id)).toMatchObject({ ok: true });
  });

  it("creates a thread once per slug and pages the thread list", async () => {
    const s = await start();
    await s.client.createManagedAgent({ slug: "a", definition: {} });
    const a = (await s.client.listAgents())[0]!;
    const first = await s.client.createThread(a.id, { vaults: [], thread_slug: "same" });
    const again = await s.client.createThread(a.id, { vaults: [], thread_slug: "same" });
    expect(idOf(again.thread)).toBe(idOf(first.thread));
    for (const n of ["x", "y", "z"])
      await s.client.createThread(a.id, { vaults: [], thread_slug: n });
    const page1 = await s.client.listThreads(a.id, { limit: 2 });
    expect(page1.threads).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await s.client.listThreads(a.id, { limit: 2, cursor: page1.next_cursor! });
    expect(page2.threads).toHaveLength(2);
    expect(page2.next_cursor ?? null).toBeNull();
  });

  it("answers 404 for unknown agents, threads and turns", async () => {
    const s = await start();
    expect((await fetch(`${s.url}/agent/nope/thread`)).status).toBe(404);
    await s.client.createManagedAgent({ slug: "a", definition: {} });
    expect((await fetch(`${s.url}/agent/a/thread/nope/event`)).status).toBe(404);
  });
});

describe("exo-sim: turns", () => {
  it("runs a plain turn to completion with messages and a usage record", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:plain]] hello");
    await ended(s, ids);
    const evs = await s.events(ids.agent, ids.thread);
    expect(evs.map((e) => e.type)).toEqual(
      expect.arrayContaining(["thread_created", "session_started", "turn_started", "turn_ended"]),
    );
    expect(evs.some((e) => e.role === "assistant" && e.text === "Plain scenario answer.")).toBe(
      true,
    );
    const usage = evs.find((e) => e.usage) as { usage: Record<string, unknown> } | undefined;
    expect(usage?.usage).toMatchObject({ model: "fake-model" });
    expect(typeof usage?.usage.cost_usd).toBe("number");
    expect((await s.client.getTurn(ids.agent, ids.thread, ids.turn)).active).toBe(false);
    expect(evs.find((e) => e.type === "turn_ended")).toMatchObject({ status: "completed" });
  });

  it("runs the generated steps12 scenario exactly once per tool call", async () => {
    const ledgerPath = join(tmp(), "ledger.jsonl");
    const s = await start({ ledgerPath });
    const ids = await turn(s, "[[scenario:steps12]] go");
    await ended(s, ids);
    expect(ledgerStats(ledgerPath)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
  });

  it("refuses a second turn while one is active (409) and accepts one after", async () => {
    const s = await start({ stepDelayMs: 150 });
    const ids = await turn(s, "[[scenario:steps12]] go");
    const res = await fetch(`${s.url}/agent/${ids.agent}/thread/${ids.thread}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "again" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_active");
    await s.client.cancelTurn(ids.agent, ids.thread, ids.turn);
    const next = await s.client.submitTurn(ids.agent, ids.thread, {
      input: "[[scenario:plain]] ok",
    });
    expect(ExoClient.turnId(next)).not.toBe(ids.turn);
  });

  it("cancels an active turn and records turn_ended as canceled", async () => {
    const s = await start({ stepDelayMs: 150 });
    const ids = await turn(s, "[[scenario:steps12]] go");
    const res = await s.client.cancelTurn(ids.agent, ids.thread, ids.turn);
    expect(res.canceled_active_turn).toBe(true);
    expect((await ended(s, ids)) as Ev).toMatchObject({ status: "canceled" });
    const again = await s.client.cancelTurn(ids.agent, ids.thread, ids.turn);
    expect(again.canceled_active_turn).toBe(false);
  });

  it("fails a turn with an unknown scenario and says why", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:does-not-exist]] x");
    expect(await ended(s, ids)).toMatchObject({ status: "failed" });
    const errors = await s.events(ids.agent, ids.thread, "?event_type=error");
    expect(String(errors[0]?.message)).toMatch(/unknown_scenario|unknown scenario/);
  });
});

describe("exo-sim: human decisions", () => {
  it("waits for an approval, then continues with the decision", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:approval-edit]] edit");
    const req = await until(
      async () =>
        (await s.events(ids.agent, ids.thread, "?event_type=agent_runtime.approval_requested"))[0],
      "approval request",
    );
    expect(req).toMatchObject({ tool: "claude.Edit" });
    expect((await s.client.getTurn(ids.agent, ids.thread, ids.turn)).active).toBe(true);
    await s.client.respondApproval(ids.agent, ids.thread, ids.turn, {
      session_id: ids.session,
      approval_id: String(req.approval_id),
      approved: true,
      allow_for_tool: false,
    });
    expect(await ended(s, ids)).toMatchObject({ status: "completed" });
    const results = await s.events(ids.agent, ids.thread, "?event_type=tool_result");
    expect(JSON.parse(String(results[0]?.output))).toEqual({ approved: true });
    // a decision is final
    const again = await fetch(
      `${s.url}/agent/${ids.agent}/thread/${ids.thread}/turn/${ids.turn}/approval-response`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval_id: req.approval_id, approved: false }),
      },
    );
    expect(again.status).toBe(409);
  });

  it("records a denial", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:approval-edit]] edit");
    const req = await until(
      async () =>
        (await s.events(ids.agent, ids.thread, "?event_type=agent_runtime.approval_requested"))[0],
      "approval request",
    );
    await s.client.respondApproval(ids.agent, ids.thread, ids.turn, {
      session_id: ids.session,
      approval_id: String(req.approval_id),
      approved: false,
      allow_for_tool: false,
    });
    await ended(s, ids);
    const results = await s.events(ids.agent, ids.thread, "?event_type=tool_result");
    expect(JSON.parse(String(results[0]?.output))).toEqual({ approved: false });
  });

  it("skips the prompt for auto-approved tools", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:approval-edit]] edit", { auto: ["claude.Edit"] });
    expect(await ended(s, ids)).toMatchObject({ status: "completed" });
    expect(
      await s.events(ids.agent, ids.thread, "?event_type=agent_runtime.approval_requested"),
    ).toEqual([]);
  });

  it("asks the human through the declared frontend tool", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:ask-user]] ask", { frontend: true });
    const req = await until(
      async () => (await s.events(ids.agent, ids.thread, "?event_type=frontend_tool_requested"))[0],
      "frontend tool request",
    );
    await s.client.sendFrontendToolResult(ids.agent, ids.thread, ids.turn, {
      session_id: ids.session,
      tool_call_id: String(req.tool_call_id),
      result: { type: "frontend_tool_success", output: "staging" },
    });
    expect(await ended(s, ids)).toMatchObject({ status: "completed" });
    const results = await s.events(ids.agent, ids.thread, "?event_type=tool_result");
    expect(results[0]?.output).toBe("staging");
  });

  it("returns an error result to the model when ask_user was not declared", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:ask-user]] ask");
    expect(await ended(s, ids)).toMatchObject({ status: "completed" });
    const results = await s.events(ids.agent, ids.thread, "?event_type=tool_result");
    expect(String(JSON.parse(String(results[0]?.output)).error)).toMatch(/not available/);
    expect(await s.events(ids.agent, ids.thread, "?event_type=frontend_tool_requested")).toEqual(
      [],
    );
  });
});

describe("exo-sim: artifacts, fork, events", () => {
  it("keeps one artifact name with two versions when a report is written twice", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:report-twice]] write");
    await ended(s, ids);
    const list = await s.client.listArtifacts(ids.agent, ids.thread);
    expect(list.filter((a) => a.name === "summary").length).toBeGreaterThanOrEqual(1);
    const read = async (version: number) =>
      (await (
        await fetch(
          `${s.url}/agent/${ids.agent}/thread/${ids.thread}/artifact/read?name=summary&version=${version}`,
        )
      ).json()) as { content: string };
    expect((await read(1)).content).toContain("first draft");
    expect((await read(2)).content).toContain("second draft");
    const latest = (await (
      await fetch(`${s.url}/agent/${ids.agent}/thread/${ids.thread}/artifact/read?name=summary`)
    ).json()) as { content: string };
    expect(latest.content).toContain("second draft");
    expect(
      (await fetch(`${s.url}/agent/${ids.agent}/thread/${ids.thread}/artifact/read?name=ghost`))
        .status,
    ).toBe(404);
  });

  it("forks a thread with its history and leaves the original alone", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:plain]] hi");
    await ended(s, ids);
    const before = await s.events(ids.agent, ids.thread);
    const fork = await s.client.forkThread(ids.agent, ids.thread, { thread_name: "copy" });
    const forked = await s.events(ids.agent, idOf(fork.thread));
    expect(forked.some((e) => e.role === "assistant" && e.text === "Plain scenario answer.")).toBe(
      true,
    );
    expect(await s.events(ids.agent, ids.thread)).toHaveLength(before.length);
    const next = await s.client.submitTurn(ids.agent, idOf(fork.thread), {
      input: "[[scenario:plain]] again",
    });
    expect(ExoClient.turnId(next)).toBeTruthy();
  });

  it("filters events by type, turn, cursor, limit and direction", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:steps12]] go");
    await ended(s, ids);
    const all = await s.events(ids.agent, ids.thread, "?limit=1000");
    const ids_ = all.map((e) => Number(e.id));
    expect(ids_).toEqual([...ids_].sort((a, b) => a - b));
    expect((await s.events(ids.agent, ids.thread, "?event_type=tool_result")).length).toBe(12);
    expect((await s.events(ids.agent, ids.thread, "?turn_id=trn_nope")).length).toBe(0);
    expect((await s.events(ids.agent, ids.thread, "?limit=3")).length).toBe(3);
    const after = await s.events(ids.agent, ids.thread, `?after=${all[4]!.id}&limit=1000`);
    expect(after[0]!.id).toBe(all[5]!.id);
    const last = await s.events(ids.agent, ids.thread, "?direction=desc&limit=1");
    expect(last[0]!.id).toBe(all[all.length - 1]!.id);
    expect(last[0]!.type).toBe("turn_ended");
  });

  it("streams events over SSE and resumes after a cursor without repeats", async () => {
    const s = await start({ stepDelayMs: 40 });
    const ids = await turn(s, "[[scenario:steps12]] go");
    const seen: string[] = [];
    for await (const e of s.client.watchEvents(ids.agent, ids.thread, {
      stopWhen: (ev) => ev.type === "turn_ended",
    })) {
      seen.push(e.id);
    }
    expect(new Set(seen).size).toBe(seen.length);
    const all = await s.events(ids.agent, ids.thread, "?limit=1000");
    expect(seen).toEqual(all.map((e) => e.id));
    const tail: string[] = [];
    for await (const e of s.client.watchEvents(ids.agent, ids.thread, {
      after: seen[seen.length - 3],
      reconnect: false,
    })) {
      tail.push(e.id);
      if (tail.length === 2) break;
    }
    expect(tail).toEqual(seen.slice(-2));
  });

  it("answers null for previews", async () => {
    const s = await start();
    const ids = await turn(s, "[[scenario:plain]] hi");
    await ended(s, ids);
    expect(await s.client.getPreviews(ids.agent, ids.thread)).toBeNull();
  });
});

describe("exo-sim: durability", () => {
  it("resumes an unfinished turn after a crash without repeating a tool call", async () => {
    const dataDir = tmp();
    const modelUrl = await fakeModel();
    const ledgerPath = join(tmp(), "ledger.jsonl");
    const first = await start({ dataDir, modelUrl, ledgerPath, stepDelayMs: 60 });
    const ids = await turn(first, "[[scenario:steps12]] go");
    await until(() => ledgerStats(ledgerPath).entries >= 3, "three ledger entries");
    first.sim.crash();
    await first.sim.abandon();
    const partial = ledgerStats(ledgerPath).entries;
    expect(partial).toBeLessThan(12);

    const second = await start({ dataDir, modelUrl, ledgerPath });
    expect(await ended(second, ids)).toMatchObject({ status: "completed" });
    expect(ledgerStats(ledgerPath)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
    const endedEvents = await second.events(ids.agent, ids.thread, "?event_type=turn_ended");
    expect(endedEvents).toHaveLength(1);
  });

  it("keeps a pending approval across a restart and finishes once decided", async () => {
    const dataDir = tmp();
    const modelUrl = await fakeModel();
    const first = await start({ dataDir, modelUrl });
    const ids = await turn(first, "[[scenario:approval-edit]] edit");
    const req = await until(
      async () =>
        (
          await first.events(ids.agent, ids.thread, "?event_type=agent_runtime.approval_requested")
        )[0],
      "approval request",
    );
    first.sim.crash();
    await first.sim.abandon();

    const second = await start({ dataDir, modelUrl });
    expect((await second.client.getTurn(ids.agent, ids.thread, ids.turn)).active).toBe(true);
    expect(
      await second.events(ids.agent, ids.thread, "?event_type=agent_runtime.approval_requested"),
    ).toHaveLength(1);
    await second.client.respondApproval(ids.agent, ids.thread, ids.turn, {
      session_id: ids.session,
      approval_id: String(req.approval_id),
      approved: true,
      allow_for_tool: false,
    });
    expect(await ended(second, ids)).toMatchObject({ status: "completed" });
  });

  it("survives a real SIGKILL of the simulator process", async () => {
    const dataDir = tmp();
    const modelUrl = await fakeModel();
    const ledgerPath = join(tmp(), "ledger.jsonl");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const spawnSim = (): ChildProcess => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(root, "exo-sim/src/main.ts")],
        {
          cwd: root,
          env: {
            ...process.env,
            EXO_SIM_DATA_DIR: dataDir,
            EXO_SIM_MODEL_URL: modelUrl,
            EXO_SIM_STEP_DELAY_MS: "80",
            EXOS_TEST_LEDGER: ledgerPath,
            EXOS_EXO_PORT: String(port),
          },
          stdio: "ignore",
        },
      );
      cleanups.push(() => void child.kill("SIGKILL"));
      return child;
    };
    const url = `http://127.0.0.1:${port}/exo`;
    const client = new ExoClient({ baseUrl: url, retries: 0 });
    const up = () =>
      until(
        async () => {
          try {
            return (await fetch(`${url}/agent`)).ok;
          } catch {
            return false;
          }
        },
        "simulator listening",
        20_000,
      );

    const a = spawnSim();
    await up();
    await client.createManagedAgent({ slug: "tester", definition: {} });
    const agent = (await client.listAgents({ slug: "tester" }))[0]!;
    const t = await client.createThread(agent.id, { vaults: [], thread_slug: "k" });
    const submitted = await client.submitTurn(agent.id, idOf(t.thread), {
      input: "[[scenario:steps12]] go",
    });
    const turnId = ExoClient.turnId(submitted);
    await until(() => ledgerStats(ledgerPath).entries >= 3, "three ledger entries", 20_000);
    const exited = new Promise<void>((r) => a.once("exit", () => r()));
    a.kill("SIGKILL");
    await exited;
    expect(existsSync(join(dataDir, "exo-sim.db"))).toBe(true);
    expect(ledgerStats(ledgerPath).entries).toBeLessThan(12);

    spawnSim();
    await up();
    await until(
      async () => !(await client.getTurn(agent.id, idOf(t.thread), turnId)).active,
      "turn finished",
      30_000,
    );
    expect(ledgerStats(ledgerPath)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
    const res = await fetch(
      `${url}/agent/${agent.id}/thread/${idOf(t.thread)}/event?event_type=turn_ended`,
    );
    const evs = ((await res.json()) as { events: Ev[] }).events;
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ status: "completed" });
  }, 60_000);
});
