import { caseId, splitCases, type Rng } from "../prng.ts";

type Pool = "anthropic" | "cursor" | "local";

interface UsageStep {
  type: "usage";
  ts: string;
  pool: Pool;
  micros: number;
}
interface BudgetStep {
  type: "budget";
  ts: string;
  pool: Pool;
  budget_micros: number;
}
type Step = UsageStep | BudgetStep;

interface Config {
  budget_micros: Record<Pool, number>;
  cycle_day: number;
  tz: "UTC";
  /** Thresholds in basis points of the budget: 7000 = 70%, 9500 = 95% (BUILD.md §4.8). */
  warn_bp: number;
  stop_bp: number;
}

const BUDGETS = [20_000_000, 50_000_000, 100_000_000];

/**
 * Reference model for the gold labels, in exact integer (BigInt) arithmetic.
 *   state = stop if S*10000 >= B*stop_bp, else warn if S*10000 >= B*warn_bp, else ok
 * A cycle runs from `cycle_day` 00:00 UTC; the label is the YYYY-MM of the cycle start.
 */
export function referenceCredit(config: Config, steps: Step[]) {
  const budget = new Map<Pool, bigint>();
  for (const [pool, v] of Object.entries(config.budget_micros)) budget.set(pool as Pool, BigInt(v));
  const spent = new Map<string, bigint>();
  return steps.map((step) => {
    const cycle = cycleLabel(step.ts, config.cycle_day);
    if (step.type === "budget") budget.set(step.pool, BigInt(step.budget_micros));
    const key = `${cycle}|${step.pool}`;
    if (step.type === "usage") spent.set(key, (spent.get(key) ?? 0n) + BigInt(step.micros));
    const S = spent.get(key) ?? 0n;
    const B = budget.get(step.pool)!;
    const state =
      S * 10000n >= B * BigInt(config.stop_bp)
        ? "stop"
        : S * 10000n >= B * BigInt(config.warn_bp)
          ? "warn"
          : "ok";
    return { cycle, pool: step.pool, spent_micros: Number(S), budget_micros: Number(B), state };
  });
}

export function cycleLabel(ts: string, cycleDay: number): string {
  const d = new Date(ts);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  if (d.getUTCDate() < cycleDay) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

const config = (budget: number, cycleDay = 1): Config => ({
  budget_micros: { anthropic: budget, cursor: budget, local: budget },
  cycle_day: cycleDay,
  tz: "UTC",
  warn_bp: 7000,
  stop_bp: 9500,
});

/** Splits `total` into `parts` positive integers that sum exactly to it. */
function partition(rng: Rng, total: number, parts: number): number[] {
  const cuts = new Set<number>();
  while (cuts.size < parts - 1) cuts.add(rng.int(1, total - 1));
  const sorted = [0, ...[...cuts].sort((a, b) => a - b), total];
  return sorted.slice(1).map((v, i) => v - sorted[i]!);
}

const at = (day: number, hour = 9, minute = 0, second = 0, month = 10) =>
  `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;

type Builder = (rng: Rng) => { config: Config; steps: Step[] };

const usage = (ts: string, pool: Pool, micros: number): UsageStep => ({
  type: "usage",
  ts,
  pool,
  micros,
});

const KINDS: Record<string, Builder> = {
  // 70% of 20 USD is exactly 14.000000: one micro below stays ok, the exact value warns.
  "exact-warn": (rng) => {
    const parts = partition(rng, 13_999_999, rng.int(2, 5));
    const steps: Step[] = parts.map((p, i) => usage(at(2 + i), "anthropic", p));
    steps.push(usage(at(9), "anthropic", 1));
    return { config: config(20_000_000), steps };
  },
  "exact-stop": (rng) => {
    const budget = rng.pick(BUDGETS);
    const stopAt = (budget * 9500) / 10000;
    const parts = partition(rng, stopAt - 1, rng.int(2, 4));
    const steps: Step[] = parts.map((p, i) => usage(at(2 + i), "anthropic", p));
    steps.push(usage(at(9), "anthropic", 1));
    return { config: config(budget), steps };
  },
  rollover: (rng) => {
    const budget = 20_000_000;
    return {
      config: config(budget),
      steps: [
        usage(at(20), "anthropic", rng.int(14_000_000, 15_000_000)),
        usage(at(31, 23, 59, 59), "anthropic", rng.int(100_000, 900_000)),
        usage(at(1, 0, 0, 0, 11), "anthropic", rng.int(1, 100_000)),
        usage(at(2, 8, 0, 0, 11), "anthropic", rng.int(1, 5_000_000)),
      ],
    };
  },
  // The only way a state may drop inside a cycle is a changed budget.
  "budget-raise": (rng) => ({
    config: config(20_000_000),
    steps: [
      usage(at(3), "anthropic", rng.int(19_000_000, 19_900_000)),
      { type: "budget", ts: at(4), pool: "anthropic", budget_micros: 100_000_000 },
      usage(at(5), "anthropic", rng.int(40_000_000, 60_000_000)),
      { type: "budget", ts: at(6), pool: "anthropic", budget_micros: 20_000_000 },
    ],
  }),
  "multi-pool": (rng) => ({
    config: config(20_000_000),
    steps: [
      usage(at(2), "anthropic", rng.int(14_000_000, 15_000_000)),
      usage(at(3), "cursor", rng.int(1_000_000, 3_000_000)),
      usage(at(4), "cursor", rng.int(15_000_000, 17_000_000)),
      usage(at(5), "anthropic", rng.int(4_000_000, 4_900_000)),
      usage(at(6), "local", 0),
    ],
  }),
  "cycle-day": (rng) => ({
    config: config(20_000_000, 15),
    steps: [
      usage(at(10), "anthropic", rng.int(10_000_000, 13_000_000)),
      usage(at(14, 23, 59, 59), "anthropic", rng.int(1_000_000, 3_000_000)),
      usage(at(15, 0, 0, 0), "anthropic", rng.int(1, 2_000_000)),
      usage(at(20), "anthropic", rng.int(10_000_000, 14_000_000)),
    ],
  }),
  "zero-cost": (rng) => ({
    config: config(20_000_000),
    steps: Array.from({ length: rng.int(4, 8) }, (_, i) => usage(at(2 + i), "local", 0)),
  }),
  monotonic: (rng) => {
    const steps: Step[] = [];
    const n = rng.int(6, 9);
    for (let i = 0; i < n; i++)
      steps.push(usage(at(2 + i), "anthropic", rng.int(1_000_000, 4_000_000)));
    return { config: config(rng.pick(BUDGETS)), steps };
  },
};

/** 24 cases (8 dev / 16 test): eight kinds, three variants each. */
export function creditSuite(rng: Rng) {
  const cases = [];
  let n = 0;
  for (const [kind, build] of Object.entries(KINDS)) {
    for (let v = 0; v < 3; v++) {
      const { config: cfg, steps } = build(rng);
      cases.push({
        id: caseId("cre", ++n),
        suite: "credit",
        kind,
        config: cfg,
        steps,
        expect: referenceCredit(cfg, steps),
      });
    }
  }
  return splitCases(rng, cases, 8);
}
