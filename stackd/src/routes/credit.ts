// Spend and credit state for the dashboard and the bridge (BUILD.md §4.6, §4.8). Figures are
// API-rate estimates computed from the meter's integer micro-dollars; dollars are for display only.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { bannerFor, worse, type CreditConfig, type PoolSnapshot } from "../credit.ts";

type Auth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const usd = (micros: number) => micros / 1_000_000;

function poolView(p: PoolSnapshot) {
  return {
    pool: p.pool,
    budget_usd: p.budget_micros === null ? null : usd(p.budget_micros),
    spent_usd: usd(p.spent_micros),
    ratio:
      p.budget_micros === null || p.budget_micros === 0
        ? null
        : Math.round((p.spent_micros / p.budget_micros) * 10_000) / 10_000,
    state: p.state,
  };
}

export function registerCreditRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: Auth,
  config: CreditConfig,
): void {
  const pre = { preHandler: auth };

  app.get("/api/v1/usage", pre, async () => {
    const { cycle, pools } = ctx.credit.snapshot();
    return {
      cycle,
      pools: pools.map(poolView),
      by_agent: ctx.credit.byAgent().map((a) => ({
        agent_id: a.agent_id,
        agent: ctx.agents.peek(a.agent_id)?.slug ?? null,
        spent_usd: usd(a.spent_micros),
      })),
      meter_lag_s: ctx.meter.lagSeconds(),
    };
  });

  app.get("/api/v1/credit", pre, async () => {
    const { cycle, pools } = ctx.credit.snapshot();
    const worst = pools.reduce<"ok" | "warn" | "stop">((acc, p) => worse(acc, p.state), "ok");
    const banner = bannerFor(worst);
    return {
      cycle,
      state: worst,
      ...(banner ? { banner } : {}),
      pools: pools.map(poolView),
      thresholds: { warn: config.warnBp / 10_000, stop: config.stopBp / 10_000 },
      cancel_active: config.cancelActive,
      estimate_note: "Figures are API-rate estimates, not what a subscription is billed.",
    };
  });
}
