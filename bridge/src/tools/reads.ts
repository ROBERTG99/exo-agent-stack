// The four read-only tools: exo_list_agents, exo_get_events, exo_thread_status, exo_usage.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeContext } from "../context.ts";
import { resolveThread, stackd } from "../stackd-client.ts";
import { fence } from "../untrusted.ts";
import { defineTool } from "./define.ts";

interface StackdEvent {
  id: string;
  type: string;
  ts: string | null;
  summary: string;
  tool?: string;
  request_id?: string;
  tool_call_id?: string;
  untrusted_text?: string;
}

export function registerReads(server: McpServer, ctx: BridgeContext): void {
  defineTool(server, ctx, "exo_list_agents", async (_args, c) => {
    const { agents } = await stackd<{
      agents: Array<{
        id: string;
        slug: string;
        name: string;
        harness: string;
        mode: "A" | "B" | "cursor" | "local";
        environment: string | null;
      }>;
    }>(c, { path: "/api/v1/agents" });
    return {
      data: {
        agents: agents.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          harness: a.harness,
          mode: a.mode,
          environment: a.environment,
        })),
      },
      text: `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
    };
  });

  defineTool(server, ctx, "exo_get_events", async (args, c) => {
    const ref = await resolveThread(c, args.thread);
    const res = await stackd<{
      events: StackdEvent[];
      next_after: string | null;
      turn_active: boolean;
    }>(c, {
      path: `/api/v1/threads/${encodeURIComponent(ref.agent)}/${encodeURIComponent(ref.thread)}/events`,
      query: {
        after: args.after,
        limit: args.limit ?? 50,
        types: args.types?.join(","),
      },
    });
    return {
      data: {
        events: res.events.map((e) => ({
          id: e.id,
          type: e.type,
          ts: e.ts,
          summary: e.summary,
          ...(e.tool ? { tool: e.tool } : {}),
          ...(e.request_id ? { request_id: e.request_id } : {}),
          ...(e.tool_call_id ? { tool_call_id: e.tool_call_id } : {}),
          ...(e.untrusted_text ? { untrusted_text: fence(e.untrusted_text) } : {}),
        })),
        next_after: res.next_after,
        turn_active: res.turn_active,
      },
      text: `${res.events.length} event${res.events.length === 1 ? "" : "s"}${res.turn_active ? "; a turn is running" : ""}`,
    };
  });

  defineTool(server, ctx, "exo_thread_status", async (args, c) => {
    const ref = await resolveThread(c, args.thread);
    const s = await stackd<{
      state:
        | "idle"
        | "running"
        | "awaiting_approval"
        | "awaiting_input"
        | "interrupted"
        | "failed_recovery";
      active_turn_id: string | null;
      pending: number;
      last_event_id: string | null;
      cost_usd: number;
      credit_state: "ok" | "warn" | "stop";
    }>(c, {
      path: `/api/v1/threads/${encodeURIComponent(ref.agent)}/${encodeURIComponent(ref.thread)}`,
    });
    return {
      data: {
        state: s.state,
        active_turn_id: s.active_turn_id,
        pending: s.pending,
        last_event_id: s.last_event_id,
        cost_usd: s.cost_usd,
        credit_state: s.credit_state,
      },
      text: `${ref.agent}/${ref.thread} is ${s.state}${s.pending > 0 ? ` with ${s.pending} pending` : ""}`,
    };
  });

  defineTool(server, ctx, "exo_usage", async (_args, c) => {
    const u = await stackd<{
      cycle: string;
      pools: Array<{
        pool: "anthropic" | "cursor" | "local";
        budget_usd: number | null;
        spent_usd: number;
        ratio: number | null;
        state: "ok" | "warn" | "stop";
      }>;
      by_agent: Array<{ agent_id: string; agent: string | null; spent_usd: number }>;
      meter_lag_s: number | null;
    }>(c, { path: "/api/v1/usage" });
    const worst = u.pools.some((p) => p.state === "stop")
      ? "stop"
      : u.pools.some((p) => p.state === "warn")
        ? "warn"
        : "ok";
    return {
      data: { cycle: u.cycle, pools: u.pools, by_agent: u.by_agent, meter_lag_s: u.meter_lag_s },
      text: `cycle ${u.cycle}: credit ${worst} (API-rate estimates)`,
    };
  });
}
