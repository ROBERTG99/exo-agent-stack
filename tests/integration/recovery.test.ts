/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are schemaless in this suite */
// T-28: the recovery supervisor against the Exo simulator (BUILD.md §4.9, FR-10).
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerStats } from "../../harnesses/scripted/ledger.ts";
import { startStack, until, type Stack } from "../helpers/stack.ts";

const stacks: Stack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});

let n = 0;
const key = () => `key-recov-${String(++n).padStart(7, "0")}`;

async function stack(opts: Parameters<typeof startStack>[0] = {}) {
  const s = await startStack(opts);
  stacks.push(s);
  return s;
}
const start = (s: Stack, prompt: string) =>
  s.call("POST", "/api/v1/threads", { agent: "repo-builder", prompt, idempotency_key: key() });
const status = async (s: Stack, slug: string) =>
  (await s.call("GET", `/api/v1/threads/repo-builder/${slug}`)).body;

describe("recovery after Exo is killed", () => {
  it("continues the cut-off turn so the task finishes with every step done once (FR-10)", async () => {
    const dir = (await stack()).dir("ledger-");
    const ledgerPath = join(dir, "ledger.jsonl");
    const s = await stack({
      ledgerPath,
      stepDelayMs: 60,
      stackd: { supervisor: { graceMs: 0, recoverEveryMs: 1_000_000 } },
    });
    const t = (await start(s, "[[scenario:steps12]] go")).body;
    await until(() => ledgerStats(ledgerPath).entries >= 3, "three steps");

    await s.restartExo("interrupt"); // SIGKILL; the restarted Exo leaves the turn interrupted
    expect(ledgerStats(ledgerPath).entries).toBeLessThan(12);
    expect((await status(s, t.thread_slug)).state).toBe("interrupted");

    await s.stackd.supervisor.tick(); // Exo is back: look for cut-off turns
    expect(s.stackd.supervisor.exoState()).toBe("up");
    await until(
      async () => (await status(s, t.thread_slug)).state === "idle",
      "the continuation to finish",
      20_000,
    );

    expect(ledgerStats(ledgerPath)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
    const ended = (
      await s.call(
        "GET",
        `/api/v1/threads/repo-builder/${t.thread_slug}/events?types=turn_ended&limit=50`,
      )
    ).body.events;
    expect(ended).toHaveLength(1); // the cut-off turn never ended; its continuation did
    expect(ended[0].data.status).toBe("completed");
    const row = s.stackd.db
      .prepare("SELECT turn_id, attempts, outcome FROM recoveries")
      .get() as any;
    expect(row).toMatchObject({ turn_id: t.turn_id, attempts: 1 });
    expect(row.outcome).toMatch(/^continued:/);
    const audit = s.stackd.db
      .prepare("SELECT actor, action FROM audit_events WHERE action = 'recovery.continue'")
      .get();
    expect(audit).toEqual({ actor: "system", action: "recovery.continue" });
  }, 60_000);

  it("waits for Exo's own resume when Exo is configured to resume turns", async () => {
    const dir = (await stack()).dir("ledger-");
    const ledgerPath = join(dir, "ledger.jsonl");
    const s = await stack({ ledgerPath, stepDelayMs: 60, stackd: { supervisor: { graceMs: 0 } } });
    const t = (await start(s, "[[scenario:steps12]] go")).body;
    await until(() => ledgerStats(ledgerPath).entries >= 3, "three steps");
    await s.restartExo("resume"); // like a harness that exports resumeTurn
    await s.stackd.supervisor.tick();
    await until(
      async () => (await status(s, t.thread_slug)).state === "idle",
      "the resumed turn to finish",
      20_000,
    );
    expect(ledgerStats(ledgerPath)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
    expect(s.stackd.db.prepare("SELECT COUNT(*) AS n FROM recoveries").get()).toEqual({ n: 0 });
  }, 60_000);

  it("shows Exo as down in the probe and on the health endpoint", async () => {
    const s = await stack({
      stepDelayMs: 40,
      stackd: { supervisor: { graceMs: 0, recoveryMaxAttempts: 0 } },
    });
    const t = (await start(s, "[[scenario:steps12]] go")).body;
    await until(() => s.sim.store.allEvents(t.thread_id).length > 6, "a few events");
    await s.stopExo();
    await s.stackd.supervisor.tick();
    expect(s.stackd.supervisor.exoState()).toBe("down");
    const health = await s.call("GET", "/api/v1/health");
    expect(health.body).toMatchObject({ status: "degraded", supervisor: { exo_state: "down" } });
  }, 30_000);

  it("marks the thread failed_recovery when no continuation is allowed", async () => {
    const s = await stack({
      stepDelayMs: 60,
      stackd: { supervisor: { graceMs: 0, recoveryMaxAttempts: 0 } },
    });
    const t = (await start(s, "[[scenario:steps12]] go")).body;
    await until(() => s.sim.store.allEvents(t.thread_id).length > 6, "a few events");
    await s.restartExo("interrupt");
    expect((await status(s, t.thread_slug)).state).toBe("interrupted");
    await s.stackd.supervisor.tick();
    expect((await status(s, t.thread_slug)).state).toBe("failed_recovery");
    expect(s.stackd.db.prepare("SELECT outcome FROM recoveries").get()).toEqual({
      outcome: "failed_recovery",
    });
    // and it stays that way: no continuation is submitted later
    await s.stackd.supervisor.recoverAll();
    expect(s.sim.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 1 });
  }, 30_000);
});

describe("limits the supervisor owns", () => {
  it("refuses a start with 429 rate_limited when the limit of running turns is reached", async () => {
    const s = await stack({ stackd: { supervisor: { maxActiveTurns: 1 } } });
    const first = await start(s, "[[scenario:approval-edit]] edit"); // waits for an approval: stays active
    expect(first.status).toBe(201);
    const second = await start(s, "[[scenario:plain]] hello");
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("rate_limited");
    await s.call(
      "POST",
      `/api/v1/threads/repo-builder/${first.body.thread_slug}/turns/${first.body.turn_id}:cancel`,
    );
    expect((await start(s, "[[scenario:plain]] hello")).status).toBe(201);
  });

  it("cancels the active turns of a pool that reaches stop when EXOS_CREDIT_CANCEL_ACTIVE is set", async () => {
    const s = await stack({
      stackd: {
        credit: {
          budgets: { anthropic: 20_000_000, cursor: 20_000_000 },
          warnBp: 7000,
          stopBp: 9500,
          cancelActive: true,
          cycle: { cycleDay: 1, tz: "UTC" },
        },
      },
    });
    const t = (await start(s, "[[scenario:approval-edit]] edit")).body;
    s.stackd.db
      .prepare(
        `INSERT INTO usage_events (event_id, agent_id, thread_id, turn_id, pool, model, cost_micros, cost_source, cycle)
         VALUES ('seed', 'agt_x', 'thr', 'trn', 'anthropic', 'm', 19500000, 'exo', ?)`,
      )
      .run(s.stackd.credit.cycle());
    expect(s.stackd.credit.state("anthropic")).toBe("stop"); // the transition triggers the cancel
    const agent = (await s.exo.listAgents({ slug: "repo-builder" }))[0]!;
    await until(
      async () => !(await s.exo.getTurn(agent.id, t.thread_id, t.turn_id)).active,
      "the turn to be cancelled",
    );
    const audit = s.stackd.db
      .prepare("SELECT action FROM audit_events WHERE action = 'turn.cancel_on_credit_stop'")
      .get();
    expect(audit).toEqual({ action: "turn.cancel_on_credit_stop" });
  });

  it("leaves active turns alone at stop when cancelling is off", async () => {
    const s = await stack();
    const t = (await start(s, "[[scenario:approval-edit]] edit")).body;
    s.stackd.db
      .prepare(
        `INSERT INTO usage_events (event_id, agent_id, thread_id, turn_id, pool, model, cost_micros, cost_source, cycle)
         VALUES ('seed', 'agt_x', 'thr', 'trn', 'anthropic', 'm', 19500000, 'exo', ?)`,
      )
      .run(s.stackd.credit.cycle());
    expect(s.stackd.credit.state("anthropic")).toBe("stop");
    const agent = (await s.exo.listAgents({ slug: "repo-builder" }))[0]!;
    expect((await s.exo.getTurn(agent.id, t.thread_id, t.turn_id)).active).toBe(true);
  });

  it("keeps the approvals queue current on each pass", async () => {
    const s = await stack({ stackd: { supervisor: { syncEveryMs: 0 } } });
    await start(s, "[[scenario:approval-edit]] edit");
    await until(
      () =>
        (s.sim.store.db.prepare("SELECT COUNT(*) AS n FROM pending").get() as any) &&
        (s.sim.store.db.prepare("SELECT COUNT(*) AS n FROM pending").get() as any).n > 0,
      "the approval",
    );
    await s.stackd.supervisor.tick();
    expect(s.stackd.approvals.list({ state: "open" })).toHaveLength(1);
  });
});
