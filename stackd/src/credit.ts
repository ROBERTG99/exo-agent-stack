// The credit guard (BUILD.md §4.8). Spend is the sum of the meter's integer micro-dollars for the
// current cycle and pool; the state is `stop` at or above the stop ratio, `warn` at or above the
// warn ratio, else `ok`, decided with integer arithmetic so a threshold is exact (14.00 of 20 is
// `warn`, 13.99 is not). The state never goes down inside a cycle unless the budget changes.
import type { AgentInfo } from "./agents.ts";
import { poolOf } from "./agents.ts";
import type { CreditGate, CreditState, Pool } from "./context.ts";
import { cycleOf, validateCycleConfig, type CycleConfig } from "./cycle.ts";
import type { Db } from "./db/index.ts";
import { ApiError } from "./errors.ts";

export const POOLS: Pool[] = ["anthropic", "cursor", "local"];
const RANK: Record<CreditState, number> = { ok: 0, warn: 1, stop: 2 };

export interface CreditConfig {
  /** Budget per budgeted pool in micro-dollars; the `local` pool has none. */
  budgets: { anthropic: number; cursor: number };
  /** Ratios in basis points (7000 = 0.70). */
  warnBp: number;
  stopBp: number;
  cancelActive: boolean;
  cycle: CycleConfig;
}

export const DEFAULT_CREDIT_CONFIG: CreditConfig = {
  budgets: { anthropic: 20_000_000, cursor: 20_000_000 },
  warnBp: 7000,
  stopBp: 9500,
  cancelActive: false,
  cycle: { cycleDay: 1, tz: "UTC" },
};

/** "20" or "13.99" as micro-dollars, without going through a float. */
export function usdToMicros(text: string, name: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`${name} must be a dollar amount such as 20 or 13.99`);
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

/** "0.95" as 9500 basis points. */
export function ratioToBp(text: string, name: string): number {
  const m = /^(0|1)(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!m) throw new Error(`${name} must be a ratio such as 0.7 (at most four decimals)`);
  return Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0"));
}

export function loadCreditConfig(env: NodeJS.ProcessEnv): CreditConfig {
  const d = DEFAULT_CREDIT_CONFIG;
  const warnBp = env.EXOS_CREDIT_WARN_RATIO
    ? ratioToBp(env.EXOS_CREDIT_WARN_RATIO, "EXOS_CREDIT_WARN_RATIO")
    : d.warnBp;
  const stopBp = env.EXOS_CREDIT_STOP_RATIO
    ? ratioToBp(env.EXOS_CREDIT_STOP_RATIO, "EXOS_CREDIT_STOP_RATIO")
    : d.stopBp;
  if (!(warnBp > 0 && warnBp < stopBp && stopBp <= 10_000)) {
    throw new Error(
      "EXOS_CREDIT_WARN_RATIO and EXOS_CREDIT_STOP_RATIO must satisfy 0 < warn < stop <= 1",
    );
  }
  return {
    budgets: {
      anthropic: env.EXOS_MONTHLY_CREDIT_USD
        ? usdToMicros(env.EXOS_MONTHLY_CREDIT_USD, "EXOS_MONTHLY_CREDIT_USD")
        : d.budgets.anthropic,
      cursor: env.EXOS_CURSOR_MONTHLY_BUDGET_USD
        ? usdToMicros(env.EXOS_CURSOR_MONTHLY_BUDGET_USD, "EXOS_CURSOR_MONTHLY_BUDGET_USD")
        : d.budgets.cursor,
    },
    warnBp,
    stopBp,
    cancelActive: env.EXOS_CREDIT_CANCEL_ACTIVE === "true",
    cycle: validateCycleConfig({
      cycleDay: env.EXOS_CREDIT_CYCLE_DAY ? Number(env.EXOS_CREDIT_CYCLE_DAY) : d.cycle.cycleDay,
      tz: env.EXOS_CREDIT_TZ || d.cycle.tz,
    }),
  };
}

/** The state for a spend and budget: exact, integer-only. */
export function stateFor(
  spent: number,
  budget: number,
  warnBp: number,
  stopBp: number,
): CreditState {
  const s = BigInt(spent) * 10_000n;
  const b = BigInt(budget);
  if (s >= b * BigInt(stopBp)) return "stop";
  if (s >= b * BigInt(warnBp)) return "warn";
  return "ok";
}

export const worse = (a: CreditState, b: CreditState): CreditState => (RANK[a] >= RANK[b] ? a : b);

export interface PoolSnapshot {
  pool: Pool;
  budget_micros: number | null;
  spent_micros: number;
  state: CreditState;
}

export interface Transition {
  pool: Pool;
  cycle: string;
  from: CreditState;
  to: CreditState;
  spent_micros: number;
  budget_micros: number;
}

export interface CreditGuardOptions {
  db: Db;
  config: CreditConfig;
  clock?: () => Date;
  audit?: (action: string, target: string, details?: Record<string, unknown>) => void;
  /** Called when a pool's state changes (metrics, and cancelling active turns in `stop`). */
  onTransition?: (t: Transition) => void;
}

export class CreditGuard implements CreditGate {
  private readonly clock: () => Date;

  constructor(private readonly o: CreditGuardOptions) {
    this.clock = o.clock ?? (() => new Date());
  }

  get config(): CreditConfig {
    return this.o.config;
  }

  cycle(): string {
    return cycleOf(this.clock(), this.o.config.cycle);
  }

  budgetOf(pool: Pool): number | null {
    return pool === "local" ? null : this.o.config.budgets[pool];
  }

  /** Recomputes a pool's state from the stored spend and persists it. */
  refresh(pool: Pool): PoolSnapshot {
    const budget = this.budgetOf(pool);
    const cycle = this.cycle();
    const spent = this.spent(cycle, pool);
    if (budget === null) return { pool, budget_micros: null, spent_micros: spent, state: "ok" };

    const { db, config } = this.o;
    const stored = db
      .prepare("SELECT budget_micros, state FROM credit_state WHERE cycle = ? AND pool = ?")
      .get(cycle, pool) as { budget_micros: number; state: CreditState } | undefined;
    const computed = stateFor(spent, budget, config.warnBp, config.stopBp);
    const budgetChanged = stored !== undefined && stored.budget_micros !== budget;
    const next = stored && !budgetChanged ? worse(stored.state, computed) : computed;
    const from: CreditState = stored?.state ?? "ok";

    if (!stored) {
      db.prepare(
        "INSERT INTO credit_state (cycle, pool, budget_micros, spent_micros, state, changed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(cycle, pool, budget, spent, next, this.clock().toISOString());
    } else {
      db.prepare(
        `UPDATE credit_state SET budget_micros = ?, spent_micros = ?, state = ?,
           changed_at = CASE WHEN state = ? THEN changed_at ELSE ? END
         WHERE cycle = ? AND pool = ?`,
      ).run(budget, spent, next, next, this.clock().toISOString(), cycle, pool);
    }
    if (budgetChanged) {
      this.o.audit?.("credit.budget_changed", `${cycle}/${pool}`, {
        from_budget_micros: stored.budget_micros,
        to_budget_micros: budget,
      });
    }
    if (next !== from) {
      const t: Transition = {
        pool,
        cycle,
        from,
        to: next,
        spent_micros: spent,
        budget_micros: budget,
      };
      this.o.audit?.("credit.transition", `${cycle}/${pool}`, { ...t });
      this.o.onTransition?.(t);
    }
    return { pool, budget_micros: budget, spent_micros: spent, state: next };
  }

  state(pool: Pool): CreditState {
    return this.refresh(pool).state;
  }

  /** Throws 402 `credit_stop` when the agent's pool is stopped. Called before any Exo request. */
  assertCanSpend(agent: Pick<AgentInfo, "slug" | "mode">): void {
    const snapshot = this.refresh(poolOf(agent));
    if (snapshot.state === "stop") {
      throw new ApiError(
        402,
        "credit_stop",
        "Credit stop",
        `the ${snapshot.pool} pool is at its stop level for ${this.cycle()}; no new work is started`,
      );
    }
  }

  snapshot(): { cycle: string; pools: PoolSnapshot[] } {
    return { cycle: this.cycle(), pools: POOLS.map((p) => this.refresh(p)) };
  }

  /** Spend per agent in the current cycle. */
  byAgent(): Array<{ agent_id: string; spent_micros: number }> {
    return this.o.db
      .prepare(
        "SELECT agent_id, SUM(cost_micros) AS spent_micros FROM usage_events WHERE cycle = ? GROUP BY agent_id ORDER BY spent_micros DESC, agent_id",
      )
      .all(this.cycle()) as Array<{ agent_id: string; spent_micros: number }>;
  }

  private spent(cycle: string, pool: Pool): number {
    const row = this.o.db
      .prepare(
        "SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM usage_events WHERE cycle = ? AND pool = ?",
      )
      .get(cycle, pool) as { micros: number };
    return row.micros;
  }
}

/** A banner the dashboard and bridge show next to responses while a pool is at `warn`. */
export function bannerFor(state: CreditState): string | undefined {
  return state === "warn"
    ? "Credit is at the warning level for this cycle."
    : state === "stop"
      ? "Credit is at the stop level: new work is refused."
      : undefined;
}
