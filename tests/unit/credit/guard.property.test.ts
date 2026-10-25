import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CreditGuard,
  DEFAULT_CREDIT_CONFIG,
  bannerFor,
  loadCreditConfig,
  ratioToBp,
  stateFor,
  usdToMicros,
  worse,
  type CreditConfig,
  type Transition,
} from "../../../stackd/src/credit.ts";
import { ApiError } from "../../../stackd/src/errors.ts";
import { freshDb } from "../db/helpers.ts";

const rank = { ok: 0, warn: 1, stop: 2 } as const;

/** The specification written out with BigInt: S × 10000 against B × basis points. */
const oracle = (s: number, b: number, warn: number, stop: number) => {
  const lhs = BigInt(s) * 10_000n;
  return lhs >= BigInt(b) * BigInt(stop) ? "stop" : lhs >= BigInt(b) * BigInt(warn) ? "warn" : "ok";
};

const ratios = fc
  .tuple(fc.integer({ min: 1, max: 9_998 }), fc.integer({ min: 1, max: 9_999 }))
  .map(([a, b]) => {
    const warn = Math.min(a, b);
    const stop = Math.max(warn + 1, Math.max(a, b));
    return { warn, stop: Math.min(stop, 10_000) };
  })
  .filter((r) => r.warn < r.stop);

describe("stateFor", () => {
  it("matches the integer oracle for any spend, budget and ratios", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        ratios,
        (spent, budget, r) => {
          expect(stateFor(spent, budget, r.warn, r.stop)).toBe(
            oracle(spent, budget, r.warn, r.stop),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never gets better as spend grows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 100_000_000 }), { maxLength: 40 }),
        ratios,
        (budget, steps, r) => {
          let spent = 0;
          let last = 0;
          for (const step of steps) {
            spent += step;
            const now = rank[stateFor(spent, budget, r.warn, r.stop)];
            expect(now).toBeGreaterThanOrEqual(last);
            last = now;
          }
        },
      ),
    );
  });

  it("is exact at the thresholds of a 20 dollar budget (FR-12)", () => {
    const B = 20_000_000;
    expect(stateFor(13_990_000, B, 7000, 9500)).toBe("ok");
    expect(stateFor(13_999_999, B, 7000, 9500)).toBe("ok");
    expect(stateFor(14_000_000, B, 7000, 9500)).toBe("warn");
    expect(stateFor(18_999_999, B, 7000, 9500)).toBe("warn");
    expect(stateFor(19_000_000, B, 7000, 9500)).toBe("stop");
  });

  it("stops a zero budget at once, and survives very large numbers without losing precision", () => {
    expect(stateFor(0, 0, 7000, 9500)).toBe("stop");
    const huge = Number.MAX_SAFE_INTEGER;
    expect(stateFor(huge, huge, 7000, 9500)).toBe("stop");
    expect(stateFor(Math.floor(huge * 0.7) - 1, huge, 7000, 9500)).toBe("ok");
  });

  it("orders states with worse()", () => {
    expect(worse("ok", "warn")).toBe("warn");
    expect(worse("stop", "warn")).toBe("stop");
    expect(worse("ok", "ok")).toBe("ok");
  });
});

describe("config parsing", () => {
  it("reads dollars and ratios without a float", () => {
    expect(usdToMicros("20", "x")).toBe(20_000_000);
    expect(usdToMicros("13.99", "x")).toBe(13_990_000);
    expect(usdToMicros("0.000001", "x")).toBe(1);
    expect(ratioToBp("0.7", "x")).toBe(7000);
    expect(ratioToBp("0.95", "x")).toBe(9500);
    expect(ratioToBp("1", "x")).toBe(10_000);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 99 }), (d, c) => {
        const text = `${d}.${String(c).padStart(2, "0")}`;
        expect(usdToMicros(text, "x")).toBe(d * 1_000_000 + c * 10_000);
      }),
    );
  });

  it("rejects malformed amounts and ratios", () => {
    for (const bad of ["", "abc", "-1", "1e3", "1.1234567", "$20"]) {
      expect(() => usdToMicros(bad, "EXOS_MONTHLY_CREDIT_USD"), bad).toThrow(
        /EXOS_MONTHLY_CREDIT_USD/,
      );
    }
    for (const bad of ["", "2", "0.12345", "-0.1", ".5"]) {
      expect(() => ratioToBp(bad, "EXOS_CREDIT_WARN_RATIO"), bad).toThrow(/EXOS_CREDIT_WARN_RATIO/);
    }
  });

  it("loads the defaults and the environment, and validates 0 < warn < stop <= 1", () => {
    expect(loadCreditConfig({})).toEqual(DEFAULT_CREDIT_CONFIG);
    const cfg = loadCreditConfig({
      EXOS_MONTHLY_CREDIT_USD: "50",
      EXOS_CURSOR_MONTHLY_BUDGET_USD: "10.5",
      EXOS_CREDIT_WARN_RATIO: "0.5",
      EXOS_CREDIT_STOP_RATIO: "1",
      EXOS_CREDIT_CANCEL_ACTIVE: "true",
      EXOS_CREDIT_CYCLE_DAY: "15",
      EXOS_CREDIT_TZ: "America/Argentina/Buenos_Aires",
    });
    expect(cfg).toEqual({
      budgets: { anthropic: 50_000_000, cursor: 10_500_000 },
      warnBp: 5000,
      stopBp: 10_000,
      cancelActive: true,
      cycle: { cycleDay: 15, tz: "America/Argentina/Buenos_Aires" },
    });
    for (const env of [
      { EXOS_CREDIT_WARN_RATIO: "0.9", EXOS_CREDIT_STOP_RATIO: "0.8" },
      { EXOS_CREDIT_WARN_RATIO: "0.7", EXOS_CREDIT_STOP_RATIO: "0.7" },
      { EXOS_CREDIT_WARN_RATIO: "0", EXOS_CREDIT_STOP_RATIO: "0.5" },
      { EXOS_CREDIT_CYCLE_DAY: "31" },
      { EXOS_CREDIT_TZ: "Nowhere/Land" },
    ]) {
      expect(() => loadCreditConfig(env), JSON.stringify(env)).toThrow();
    }
  });
});

// --- the guard against a database ---------------------------------------------------------------

let seq = 0;
function guardWith(over: Partial<CreditConfig> = {}) {
  const { db } = freshDb();
  let now = new Date("2026-10-15T12:00:00Z");
  const transitions: Transition[] = [];
  const audits: Array<{ action: string; target: string }> = [];
  const config: CreditConfig = { ...DEFAULT_CREDIT_CONFIG, ...over };
  const guard = new CreditGuard({
    db,
    config,
    clock: () => now,
    audit: (action, target) => audits.push({ action, target }),
    onTransition: (t) => transitions.push(t),
  });
  const spend = (micros: number, pool = "anthropic", cycle = "2026-10", agent = "agt_1") =>
    db
      .prepare(
        `INSERT INTO usage_events (event_id, agent_id, thread_id, turn_id, pool, model, cost_micros, cost_source, cycle)
         VALUES (?, ?, 'thr', 'trn', ?, 'm', ?, 'exo', ?)`,
      )
      .run(`e${++seq}`, agent, pool, micros, cycle);
  return { db, guard, spend, transitions, audits, setNow: (d: Date) => (now = d), config };
}

describe("CreditGuard", () => {
  it("is ok with no spend and records the cycle's state row", () => {
    const { guard, db } = guardWith();
    expect(guard.state("anthropic")).toBe("ok");
    expect(
      db.prepare("SELECT cycle, pool, budget_micros, spent_micros, state FROM credit_state").all(),
    ).toEqual([
      {
        cycle: "2026-10",
        pool: "anthropic",
        budget_micros: 20_000_000,
        spent_micros: 0,
        state: "ok",
      },
    ]);
  });

  it("warns exactly at 14.00 of 20 and stops at 19.00, with an audit event and a callback each", () => {
    const { guard, spend, transitions, audits } = guardWith();
    spend(13_990_000);
    expect(guard.state("anthropic")).toBe("ok");
    spend(10_000);
    expect(guard.state("anthropic")).toBe("warn");
    spend(4_999_999);
    expect(guard.state("anthropic")).toBe("warn");
    spend(1);
    expect(guard.state("anthropic")).toBe("stop");
    expect(transitions.map((t) => `${t.from}>${t.to}`)).toEqual(["ok>warn", "warn>stop"]);
    expect(audits.filter((a) => a.action === "credit.transition")).toHaveLength(2);
    guard.state("anthropic");
    expect(transitions).toHaveLength(2); // no repeat while the state holds
  });

  it("refuses with 402 credit_stop only in the stopped pool", () => {
    const { guard, spend } = guardWith();
    spend(19_000_000, "anthropic");
    expect(() => guard.assertCanSpend({ slug: "a", mode: "A" })).toThrow(ApiError);
    try {
      guard.assertCanSpend({ slug: "a", mode: "B" });
    } catch (err) {
      expect(err).toMatchObject({ status: 402, code: "credit_stop" });
    }
    expect(() => guard.assertCanSpend({ slug: "c", mode: "cursor" })).not.toThrow();
    expect(() => guard.assertCanSpend({ slug: "l", mode: "local" })).not.toThrow();
  });

  it("never goes down within a cycle for any sequence of spend", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 3_000_000 }), { maxLength: 30 }), (steps) => {
        const { guard, spend } = guardWith();
        let last = 0;
        let total = 0;
        for (const step of steps) {
          spend(step);
          total += step;
          const state = guard.state("anthropic");
          expect(rank[state]).toBeGreaterThanOrEqual(last);
          expect(state).toBe(stateFor(total, 20_000_000, 7000, 9500));
          last = rank[state];
        }
      }),
      { numRuns: 100 },
    );
  });

  it("keeps a worse stored state even if the computed one would be better, until the budget changes", () => {
    const { guard, spend, db, audits } = guardWith();
    spend(19_500_000);
    expect(guard.state("anthropic")).toBe("stop");
    // the spend rows are removed (a correction): the stored stop stays within the cycle
    db.prepare("DELETE FROM usage_events").run();
    expect(guard.state("anthropic")).toBe("stop");
    // a bigger budget re-evaluates from the facts
    const bigger = new CreditGuard({
      db,
      config: { ...DEFAULT_CREDIT_CONFIG, budgets: { anthropic: 100_000_000, cursor: 20_000_000 } },
      clock: () => new Date("2026-10-15T12:00:00Z"),
      audit: (action, target) => audits.push({ action, target }),
    });
    expect(bigger.state("anthropic")).toBe("ok");
    expect(audits.some((a) => a.action === "credit.budget_changed")).toBe(true);
  });

  it("starts a new cycle from zero and keeps pools apart", () => {
    const { guard, spend, setNow } = guardWith();
    spend(19_500_000, "anthropic", "2026-10");
    spend(1_000_000, "cursor", "2026-10");
    expect(guard.state("anthropic")).toBe("stop");
    expect(guard.state("cursor")).toBe("ok");
    setNow(new Date("2026-11-01T00:00:00Z"));
    expect(guard.cycle()).toBe("2026-11");
    expect(guard.state("anthropic")).toBe("ok");
  });

  it("has no budget for the local pool and reports spend per agent and per pool", () => {
    const { guard, spend } = guardWith();
    spend(5_000_000, "local");
    spend(3_000_000, "anthropic", "2026-10", "agt_a");
    spend(1_000_000, "anthropic", "2026-10", "agt_b");
    spend(9_000_000, "anthropic", "2025-01", "agt_a"); // another cycle
    expect(guard.state("local")).toBe("ok");
    const snap = guard.snapshot();
    expect(snap.cycle).toBe("2026-10");
    expect(snap.pools.map((p) => [p.pool, p.budget_micros, p.spent_micros, p.state])).toEqual([
      ["anthropic", 20_000_000, 4_000_000, "ok"],
      ["cursor", 20_000_000, 0, "ok"],
      ["local", null, 5_000_000, "ok"],
    ]);
    expect(guard.byAgent()).toEqual([
      { agent_id: "agt_1", spent_micros: 5_000_000 },
      { agent_id: "agt_a", spent_micros: 3_000_000 },
      { agent_id: "agt_b", spent_micros: 1_000_000 },
    ]);
  });

  it("describes warn and stop for the banner", () => {
    expect(bannerFor("ok")).toBeUndefined();
    expect(bannerFor("warn")).toMatch(/warning/);
    expect(bannerFor("stop")).toMatch(/refused/);
  });
});
