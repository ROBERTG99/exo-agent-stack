// T-26: the credit guard in the API (BUILD.md §4.8, FR-12).
import { afterEach, describe, expect, it } from "vitest";
import { startStack, until, type Stack } from "../helpers/stack.ts";

const stacks: Stack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});

let n = 0;
const key = () => `key-credit-${String(++n).padStart(6, "0")}`;

async function stack() {
  const exoCalls: string[] = [];
  const s = await startStack({
    stackd: {
      fetchImpl: ((url: string | URL, init?: RequestInit) => {
        exoCalls.push(`${init?.method ?? "GET"} ${String(url)}`);
        return fetch(url, init);
      }) as typeof fetch,
    },
  });
  stacks.push(s);
  // read the catalogue once, as the meter's first pass would, so agents are known locally
  await s.call("GET", "/api/v1/agents");
  return { s, exoCalls };
}

let seq = 0;
function spend(s: Stack, micros: number, pool = "anthropic", agent = "agt_x") {
  const cycle = s.stackd.credit.cycle();
  s.stackd.db
    .prepare(
      `INSERT INTO usage_events (event_id, agent_id, thread_id, turn_id, pool, model, cost_micros, cost_source, cycle)
       VALUES (?, ?, 'thr', 'trn', ?, 'm', ?, 'exo', ?)`,
    )
    .run(`seed${++seq}`, agent, pool, micros, cycle);
}
const start = (over: Record<string, unknown> = {}) => ({
  agent: "repo-builder",
  prompt: "[[scenario:plain]] hello",
  idempotency_key: key(),
  ...over,
});

describe("credit stop", () => {
  it("answers 402 credit_stop before any Exo request, for start, send and fork", async () => {
    const { s, exoCalls } = await stack();
    const first = await s.call("POST", "/api/v1/threads", start());
    expect(first.status).toBe(201);
    await until(
      async () =>
        (await s.call("GET", `/api/v1/threads/repo-builder/${first.body.thread_slug}`)).body
          .state === "idle",
      "idle",
    );

    spend(s, 19_000_000);
    exoCalls.length = 0;
    const calls = [
      s.call("POST", "/api/v1/threads", start()),
      s.call("POST", `/api/v1/threads/repo-builder/${first.body.thread_slug}/turns`, {
        message: "more",
        idempotency_key: key(),
      }),
      s.call("POST", `/api/v1/threads/repo-builder/${first.body.thread_slug}:fork`, {
        idempotency_key: key(),
      }),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(402);
      expect(r.body.code).toBe("credit_stop");
      expect(r.headers.get("content-type")).toContain("application/problem+json");
    }
    expect(exoCalls).toEqual([]);
  });

  it("leaves other pools and read endpoints working, and a replay of an earlier start", async () => {
    const { s } = await stack();
    const earlier = start();
    const first = await s.call("POST", "/api/v1/threads", earlier);
    spend(s, 19_000_000);
    expect(
      (await s.call("POST", "/api/v1/threads", start({ agent: "reviewer-cursor" }))).status,
    ).toBe(201);
    expect(
      (await s.call("GET", `/api/v1/threads/repo-builder/${first.body.thread_slug}`)).status,
    ).toBe(200);
    const replay = await s.call("POST", "/api/v1/threads", earlier);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
  });

  it("frees the idempotency key when refused, so the same request can start once credit is back", async () => {
    const { s } = await stack();
    spend(s, 19_000_000);
    const body = start();
    expect((await s.call("POST", "/api/v1/threads", body)).status).toBe(402);
    s.stackd.db.prepare("DELETE FROM usage_events").run();
    s.stackd.db.prepare("UPDATE credit_state SET budget_micros = budget_micros + 1").run(); // a budget change re-evaluates
    expect(s.stackd.credit.state("anthropic")).toBe("ok");
    expect((await s.call("POST", "/api/v1/threads", body)).status).toBe(201);
  });
});

describe("credit warn", () => {
  it("adds credit_state and a banner to responses at 14.00 of 20, not at 13.99", async () => {
    const { s } = await stack();
    spend(s, 13_990_000);
    const below = await s.call("POST", "/api/v1/threads", start());
    expect(below.body.credit_state).toBe("ok");
    expect(below.body.banner).toBeUndefined();
    spend(s, 10_000);
    const at = await s.call("POST", "/api/v1/threads", start());
    expect(at.status).toBe(201);
    expect(at.body).toMatchObject({
      credit_state: "warn",
      banner: expect.stringContaining("warning"),
    });
    const credit = await s.call("GET", "/api/v1/credit");
    expect(credit.body).toMatchObject({
      state: "warn",
      thresholds: { warn: 0.7, stop: 0.95 },
      cancel_active: false,
      banner: expect.any(String),
    });
  });
});

describe("usage and the meter", () => {
  it("meters what Exo recorded and reports it by pool and agent", async () => {
    const { s } = await stack();
    const a = await s.call("POST", "/api/v1/threads", start({ prompt: "[[scenario:steps12]] go" }));
    await until(
      async () =>
        (await s.call("GET", `/api/v1/threads/repo-builder/${a.body.thread_slug}`)).body.state ===
        "idle",
      "idle",
    );
    const r = await s.stackd.meter.ingestOnce();
    expect(r.ingested).toBeGreaterThan(0);
    expect((await s.stackd.meter.ingestOnce()).ingested).toBe(0);

    const fromExo = s.sim.store
      .allEvents(a.body.thread_id)
      .filter((e) => e.type === "messages" && e.usage)
      .map((e) => (e.usage as { cost_usd: number }).cost_usd);
    const expectedMicros = fromExo.reduce((sum, c) => sum + Math.round(c * 1_000_000), 0);
    expect(expectedMicros).toBeGreaterThan(0);

    const usage = await s.call("GET", "/api/v1/usage");
    expect(usage.status).toBe(200);
    const anthropic = usage.body.pools.find((p: { pool: string }) => p.pool === "anthropic");
    expect(Math.round(anthropic.spent_usd * 1_000_000)).toBe(expectedMicros);
    expect(anthropic).toMatchObject({ budget_usd: 20, state: "ok" });
    expect(usage.body.by_agent[0]).toMatchObject({ agent: "repo-builder" });
    expect(usage.body.cycle).toMatch(/^\d{4}-\d{2}$/);
    expect(usage.body.meter_lag_s).toBeGreaterThanOrEqual(0);
  });

  it("reports no lag before the first pass", async () => {
    const { s } = await stack();
    const usage = await s.call("GET", "/api/v1/usage");
    expect(usage.body.meter_lag_s).toBeNull();
    expect(usage.body.pools).toHaveLength(3);
  });

  it("needs the local token", async () => {
    const { s } = await stack();
    for (const path of ["/api/v1/usage", "/api/v1/credit"]) {
      expect((await fetch(`${s.url}${path}`)).status).toBe(401);
    }
  });
});
