import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cycleOf, validateCycleConfig } from "../../../stackd/src/cycle.ts";
import { Meter } from "../../../stackd/src/meter.ts";
import { costMicros, highestRates, loadRates, ratesAgeDays } from "../../../stackd/src/pricing.ts";
import { freshDb } from "../db/helpers.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const rates = loadRates(join(root, "pricing/api-rates.v1.json"));
const M = 1_000_000;

describe("price table", () => {
  it("is the committed table with a source and a retrieval date", () => {
    expect(rates.source_url).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
    expect(rates.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(rates.models)).toEqual(
      expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
    );
  });

  it("reports its age in whole days", () => {
    expect(ratesAgeDays(rates, new Date(`${rates.retrieved_at}T12:00:00Z`))).toBe(0);
    expect(
      ratesAgeDays(
        rates,
        new Date(Date.parse(`${rates.retrieved_at}T00:00:00Z`) + 121 * 86_400_000),
      ),
    ).toBe(121);
  });

  it("takes the highest rate per category across models and tiers", () => {
    expect(highestRates(rates)).toEqual({
      input: 10_000_000,
      cache_write: 12_500_000,
      cache_read: 250_000,
      output: 50_000_000,
    });
  });
});

describe("costMicros", () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    model: "claude-opus-5-5",
    prompt_tokens: 0,
    completion_tokens: 0,
    prompt_cached_tokens: 0,
    prompt_cache_creation_tokens: 0,
    ...over,
  });

  it("trusts a positive cost from Exo and rounds it to a micro-dollar", () => {
    expect(costMicros(usage({ cost_usd: 0.1234567, prompt_tokens: 5 }), rates)).toEqual({
      micros: 123_457,
      source: "exo",
    });
  });

  it("prices tokens from the table when Exo gave no cost or zero", () => {
    const u = usage({
      prompt_tokens: M,
      completion_tokens: M,
      prompt_cached_tokens: M,
      prompt_cache_creation_tokens: M,
    });
    // Opus 5.5: $4 input + $5 cache write + $0.20 cache read + $20 output per million tokens.
    expect(costMicros(u, rates)).toEqual({ micros: 29_200_000, source: "price_table" });
    expect(costMicros({ ...u, cost_usd: 0 }, rates).source).toBe("price_table");
  });

  it("rounds a fraction of a micro-dollar up, never down", () => {
    // Haiku 5.5 input is $0.10 per million tokens: one token is 0.1 micro-dollar.
    expect(costMicros(usage({ model: "claude-haiku-5-5", prompt_tokens: 1 }), rates).micros).toBe(
      1,
    );
    expect(costMicros(usage({ model: "claude-haiku-5-5", prompt_tokens: 10 }), rates).micros).toBe(
      1,
    );
    expect(costMicros(usage({ model: "claude-haiku-5-5", prompt_tokens: 11 }), rates).micros).toBe(
      2,
    );
  });

  it("uses the long-prompt rates for Haiku 5.5 above 100,000 prompt tokens", () => {
    const small = costMicros(usage({ model: "claude-haiku-5-5", prompt_tokens: 100_000 }), rates);
    const large = costMicros(usage({ model: "claude-haiku-5-5", prompt_tokens: 100_001 }), rates);
    expect(small.micros).toBe(10_000); // $0.10 per million
    expect(large.micros).toBe(50_001); // $0.50 per million, rounded up
  });

  it("stays exact for very large token counts (no float error)", () => {
    const huge = costMicros(
      usage({ model: "claude-fable-5-1", completion_tokens: 900_000_000 }),
      rates,
    );
    expect(huge.micros).toBe(45_000_000_000); // $45,000
  });

  it("prices an unknown model at the highest rate and says so", () => {
    expect(costMicros(usage({ model: "mystery-model", prompt_tokens: M }), rates)).toEqual({
      micros: 10_000_000,
      source: "max_estimate",
    });
    expect(costMicros({ prompt_tokens: M }, rates).source).toBe("max_estimate");
  });

  it("never mistakes an inherited property for a listed model", () => {
    for (const model of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(costMicros(usage({ model, prompt_tokens: M }), rates), model).toEqual({
        micros: 10_000_000,
        source: "max_estimate",
      });
    }
  });

  it("charges nothing for no tokens, and always nothing in the local pool", () => {
    expect(costMicros(usage(), rates)).toEqual({ micros: 0, source: "exo" });
    expect(costMicros(usage({ prompt_tokens: M, cost_usd: 5 }), rates, "local")).toEqual({
      micros: 0,
      source: "exo",
    });
  });

  it("ignores negative and non-finite token counts", () => {
    expect(
      costMicros(
        usage({ prompt_tokens: -5, completion_tokens: Number.NaN, cost_usd: Number.NaN }),
        rates,
      ).micros,
    ).toBe(0);
  });
});

describe("cycleOf", () => {
  const utc = { cycleDay: 1, tz: "UTC" };
  it("labels with the month the cycle started in", () => {
    expect(cycleOf(new Date("2026-10-25T12:00:00Z"), utc)).toBe("2026-10");
    expect(cycleOf(new Date("2026-11-01T00:00:00Z"), utc)).toBe("2026-11");
    expect(cycleOf(new Date("2026-10-31T23:59:59Z"), utc)).toBe("2026-10");
  });

  it("starts a cycle on the configured day", () => {
    const c = { cycleDay: 15, tz: "UTC" };
    expect(cycleOf(new Date("2026-10-14T23:59:59Z"), c)).toBe("2026-09");
    expect(cycleOf(new Date("2026-10-15T00:00:00Z"), c)).toBe("2026-10");
    expect(cycleOf(new Date("2027-01-03T00:00:00Z"), c)).toBe("2026-12");
  });

  it("uses the configured time zone for midnight", () => {
    const ba = { cycleDay: 1, tz: "America/Argentina/Buenos_Aires" }; // UTC-3
    expect(cycleOf(new Date("2026-11-01T02:00:00Z"), ba)).toBe("2026-10");
    expect(cycleOf(new Date("2026-11-01T03:00:00Z"), ba)).toBe("2026-11");
  });

  it("validates the day and the zone", () => {
    expect(() => validateCycleConfig({ cycleDay: 0, tz: "UTC" })).toThrow(/1 to 28/);
    expect(() => validateCycleConfig({ cycleDay: 29, tz: "UTC" })).toThrow(/1 to 28/);
    expect(() => validateCycleConfig({ cycleDay: 1.5, tz: "UTC" })).toThrow(/1 to 28/);
    expect(() => validateCycleConfig({ cycleDay: 1, tz: "Mars/Olympus" })).toThrow(/time zone/);
    expect(validateCycleConfig({ cycleDay: 28, tz: "UTC" })).toEqual({ cycleDay: 28, tz: "UTC" });
  });
});

// --- ingest -------------------------------------------------------------------------------------

type Ev = Record<string, unknown> & { id: string; type: string };
const msg = (
  id: string,
  usage: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): Ev => ({
  id,
  type: "messages",
  turn_id: "trn_1",
  ts: "2026-10-10T10:00:00.000Z",
  ...(usage ? { usage } : {}),
  ...extra,
});

/** A stand-in for ExoClient with a fixed catalogue; `events` holds each thread's messages. */
function stubExo(events: Record<string, Ev[]>, harness = "../harnesses/claude-host/harness.ts") {
  const calls: Array<{ thread: string; after?: string; limit?: number; event_type?: string }> = [];
  const exo = {
    listAgents: async () => [{ id: "agt_1", slug: "a", name: "a", harness }],
    listThreads: async () => ({
      threads: Object.keys(events).map((id) => ({ id, slug: id })),
      next_cursor: null,
    }),
    listEvents: async (
      _agent: string,
      thread: string,
      q: { after?: string; limit?: number; event_type?: string },
    ) => {
      calls.push({ thread, ...q });
      const all = (events[thread] ?? []).filter((e) => !q.event_type || e.type === q.event_type);
      const after = q.after === undefined ? -1 : all.findIndex((e) => e.id === q.after);
      return all.slice(after + 1, after + 1 + (q.limit ?? 200));
    },
  };
  return { exo: exo as never, calls };
}

const U = {
  model: "claude-opus-5-5",
  prompt_tokens: 1000,
  completion_tokens: 500,
  prompt_cached_tokens: 0,
  prompt_cache_creation_tokens: 0,
  completion_reasoning_tokens: 0,
};

function meterWith(events: Record<string, Ev[]>, harness?: string) {
  const { db } = freshDb();
  const stub = stubExo(events, harness);
  let now = new Date("2026-10-25T00:00:00Z");
  const touched: unknown[] = [];
  const meter = new Meter({
    db,
    exo: stub.exo,
    rates,
    cycle: { cycleDay: 1, tz: "UTC" },
    clock: () => now,
    onIngested: (t) => touched.push(t),
  });
  return { db, meter, stub, touched, setNow: (d: Date) => (now = d) };
}

describe("Meter.ingestOnce", () => {
  it("stores one row per usage event with pool, cycle and integer cost", async () => {
    const { db, meter, touched } = meterWith({
      thr_1: [
        msg("1", U),
        msg("2", null, { role: "user", text: "hi" }),
        msg("3", { ...U, cost_usd: 0.25 }),
      ],
    });
    const r = await meter.ingestOnce();
    expect(r).toMatchObject({
      ingested: 2,
      threads: 1,
      touched: [{ cycle: "2026-10", pool: "anthropic" }],
    });
    const rows = db.prepare("SELECT * FROM usage_events ORDER BY event_id").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.map((x) => [x.event_id, x.pool, x.cycle, x.cost_micros, x.cost_source])).toEqual([
      ["thr_1:1", "anthropic", "2026-10", 14_000, "price_table"], // 1000×$4 + 500×$20 per million = 4,000 + 10,000
      ["thr_1:3", "anthropic", "2026-10", 250_000, "exo"],
    ]);
    expect(touched).toHaveLength(1);
  });

  it("does not read events twice: the cursor moves, and a repeat inserts nothing", async () => {
    const { meter, stub, db } = meterWith({ thr_1: [msg("1", U), msg("2", U)] });
    await meter.ingestOnce();
    const second = await meter.ingestOnce();
    expect(second.ingested).toBe(0);
    expect(stub.calls.at(-1)).toMatchObject({
      thread: "thr_1",
      after: "2",
      event_type: "messages",
    });
    expect(db.prepare("SELECT last_event_id FROM meter_cursors").get()).toEqual({
      last_event_id: "2",
    });
  });

  it("picks up events that arrive later", async () => {
    const events = { thr_1: [msg("1", U)] };
    const { meter, db } = meterWith(events);
    await meter.ingestOnce();
    events.thr_1.push(msg("2", U));
    expect((await meter.ingestOnce()).ingested).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 2 });
  });

  it("keeps threads apart even when their event ids collide", async () => {
    const { meter, db } = meterWith({
      thr_1: [msg("1", U)],
      thr_2: [msg("1", U, { turn_id: "trn_2" })],
    });
    expect((await meter.ingestOnce()).ingested).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 2 });
  });

  it("counts the events of a turn once when a fork shows them again under other event ids", async () => {
    const { meter, db } = meterWith({
      thr_1: [msg("1", U), msg("2", U)],
      thr_fork: [msg("9", U), msg("10", U), msg("11", U, { turn_id: "trn_new" })],
    });
    const r = await meter.ingestOnce();
    expect(r.ingested).toBe(3); // two of the original turn, one new turn of the fork
    expect(
      db.prepare("SELECT turn_id, COUNT(*) AS n FROM usage_events GROUP BY turn_id").all(),
    ).toEqual([
      { turn_id: "trn_1", n: 2 },
      { turn_id: "trn_new", n: 1 },
    ]);
  });

  it("assigns an event to the cycle its timestamp falls in, not the cycle it was read in", async () => {
    const { meter, db } = meterWith({
      thr_1: [
        msg("1", U, { ts: "2026-09-30T23:00:00.000Z" }),
        msg("2", U, { ts: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    await meter.ingestOnce();
    expect(db.prepare("SELECT cycle FROM usage_events ORDER BY event_id").all()).toEqual([
      { cycle: "2026-09" },
      { cycle: "2026-10" },
    ]);
  });

  it("falls back to the clock when an event has no usable timestamp", async () => {
    const { meter, db } = meterWith({ thr_1: [msg("1", U, { ts: "not a date" })] });
    await meter.ingestOnce();
    expect(db.prepare("SELECT cycle FROM usage_events").get()).toEqual({ cycle: "2026-10" });
  });

  it("counts cursor and local agents in their own pools, local at zero cost", async () => {
    const cursor = meterWith({ thr_1: [msg("1", { ...U, model: "auto" })] }, "cursor");
    await cursor.meter.ingestOnce();
    expect(cursor.db.prepare("SELECT pool, cost_source FROM usage_events").get()).toEqual({
      pool: "cursor",
      cost_source: "max_estimate",
    });
    const local = meterWith(
      { thr_1: [msg("1", { ...U, model: "qwen" })] },
      "../harnesses/local-shim/harness.ts",
    );
    await local.meter.ingestOnce();
    expect(local.db.prepare("SELECT pool, cost_micros FROM usage_events").get()).toEqual({
      pool: "local",
      cost_micros: 0,
    });
  });

  it("pages through more events than one request returns", async () => {
    const many = Array.from({ length: 450 }, (_, i) => msg(String(i + 1), U));
    const { meter, db, stub } = meterWith({ thr_1: many });
    expect((await meter.ingestOnce()).ingested).toBe(450);
    expect(stub.calls.filter((c) => c.thread === "thr_1").length).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 450 });
  });

  it("meters an event with a hostile model id at the highest rate and keeps going", async () => {
    const { meter, db } = meterWith({
      thr_1: [
        msg("1", { ...U, model: "__proto__" }),
        msg("2", { ...U, model: "constructor" }),
        msg("3", U),
      ],
    });
    expect((await meter.ingestOnce()).ingested).toBe(3);
    expect(
      db.prepare("SELECT model, cost_source FROM usage_events ORDER BY event_id").all(),
    ).toEqual([
      { model: "__proto__", cost_source: "max_estimate" },
      { model: "constructor", cost_source: "max_estimate" },
      { model: "claude-opus-5-5", cost_source: "price_table" },
    ]);
  });

  it("shares one pass between overlapping calls", async () => {
    const { meter, stub } = meterWith({ thr_1: [msg("1", U)] });
    const [a, b] = await Promise.all([meter.ingestOnce(), meter.ingestOnce()]);
    expect(a).toBe(b);
    expect(stub.calls.filter((c) => c.thread === "thr_1")).toHaveLength(1);
  });

  it("reports lag only after a complete pass and leaves the cursor alone when Exo fails mid-pass", async () => {
    const { meter, setNow, db } = meterWith({ thr_1: [msg("1", U)] });
    expect(meter.lagSeconds()).toBeNull();
    await meter.ingestOnce();
    setNow(new Date("2026-10-25T00:00:42Z"));
    expect(meter.lagSeconds()).toBe(42);

    const failing = new Meter({
      db,
      exo: {
        listAgents: async () => {
          throw new Error("exo down");
        },
      } as never,
      rates,
      cycle: { cycleDay: 1, tz: "UTC" },
    });
    await expect(failing.ingestOnce()).rejects.toThrow("exo down");
    expect(failing.lagSeconds()).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 1 });
  });
});
