// The writing tools: exo_start_thread, exo_send, exo_fork, exo_answer, and exo_approve.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeContext } from "../context.ts";
import { BridgeError } from "../errors.ts";
import { resolveThread, stackd } from "../stackd-client.ts";
import { defineTool } from "./define.ts";

type CreditState = "ok" | "warn" | "stop";
const creditFields = (r: { credit_state?: CreditState; banner?: string }) => ({
  ...(r.credit_state ? { credit_state: r.credit_state } : {}),
  ...(r.banner ? { banner: r.banner } : {}),
});

export function registerWrites(server: McpServer, ctx: BridgeContext): void {
  defineTool(server, ctx, "exo_start_thread", async (args, c) => {
    const r = await stackd<{
      agent_id: string;
      thread_id: string;
      thread_slug: string;
      turn_id: string;
      session_id: string;
      worktree_path?: string;
      dashboard_url: string;
      replayed: boolean;
      credit_state?: CreditState;
      banner?: string;
    }>(c, {
      method: "POST",
      path: "/api/v1/threads",
      body: {
        agent: args.agent,
        prompt: args.prompt,
        workspace: args.workspace,
        resources: args.resources,
        thread_name: args.thread_name,
        idempotency_key: args.idempotency_key,
      },
    });
    return {
      data: {
        agent_id: r.agent_id,
        thread_id: r.thread_id,
        thread_slug: r.thread_slug,
        turn_id: r.turn_id,
        session_id: r.session_id,
        ...(r.worktree_path ? { worktree_path: r.worktree_path } : {}),
        dashboard_url: r.dashboard_url,
        replayed: r.replayed,
        ...creditFields(r),
      },
      text: `${r.replayed ? "Already started" : "Started"} thread ${r.thread_slug} (turn ${r.turn_id}). Dashboard: ${r.dashboard_url}`,
    };
  });

  defineTool(server, ctx, "exo_send", async (args, c) => {
    const ref = await resolveThread(c, args.thread);
    const r = await stackd<{
      turn_id: string;
      session_id: string;
      replayed: boolean;
      credit_state?: CreditState;
      banner?: string;
    }>(c, {
      method: "POST",
      path: `/api/v1/threads/${encodeURIComponent(ref.agent)}/${encodeURIComponent(ref.thread)}/turns`,
      body: { message: args.message, idempotency_key: args.idempotency_key },
    });
    return {
      data: {
        turn_id: r.turn_id,
        session_id: r.session_id,
        replayed: r.replayed,
        ...creditFields(r),
      },
      text: `${r.replayed ? "Already sent" : "Sent"} to ${ref.agent}/${ref.thread} (turn ${r.turn_id})`,
    };
  });

  defineTool(server, ctx, "exo_fork", async (args, c) => {
    const ref = await resolveThread(c, args.thread);
    const r = await stackd<{
      thread_id: string;
      thread_slug: string;
      forked_from: string;
      replayed: boolean;
    }>(c, {
      method: "POST",
      path: `/api/v1/threads/${encodeURIComponent(ref.agent)}/${encodeURIComponent(ref.thread)}:fork`,
      body: { at: args.at, name: args.name, idempotency_key: args.idempotency_key },
    });
    return {
      data: {
        thread_id: r.thread_id,
        thread_slug: r.thread_slug,
        forked_from: r.forked_from,
        replayed: r.replayed,
      },
      text: `${r.replayed ? "Already forked" : "Forked"} ${r.forked_from} into ${r.thread_slug}`,
    };
  });

  defineTool(server, ctx, "exo_answer", async (args, c) => {
    const ref = await resolveThread(c, args.thread);
    const r = await stackd<{ recorded_event_id: string | null; replayed?: boolean }>(c, {
      method: "POST",
      path: `/api/v1/frontend-tools/${encodeURIComponent(args.tool_call_id)}:answer`,
      body: { answer: args.answer, thread: ref.thread, idempotency_key: args.idempotency_key },
    });
    return {
      data: { recorded_event_id: r.recorded_event_id, replayed: r.replayed ?? false },
      text: `Answer recorded for ${ref.agent}/${ref.thread}`,
    };
  });

  defineTool(server, ctx, "exo_approve", async (args, c) => {
    const ref = await resolveThread(c, args.thread);
    // The request must belong to this thread, and still be open.
    const { approvals } = await stackd<{
      approvals: Array<{ approval_id: string; decision: string; kind: string }>;
    }>(c, { path: "/api/v1/approvals", query: { state: "all", thread: ref.thread } });
    const row = approvals.find((a) => a.approval_id === args.request_id);
    if (!row)
      throw new BridgeError(
        "not_found",
        `no approval ${args.request_id.slice(0, 80)} on ${ref.agent}/${ref.thread}`,
      );
    const r = await stackd<{
      approval_id: string;
      decision: "approved" | "denied" | "approved_for_session";
      recorded_event_id: string | null;
      replayed?: boolean;
    }>(c, {
      method: "POST",
      path: `/api/v1/approvals/${encodeURIComponent(args.request_id)}:decide`,
      body: { decision: args.decision, reason: args.reason, idempotency_key: args.idempotency_key },
    });
    return {
      data: {
        approval_id: r.approval_id,
        decision: r.decision,
        recorded_event_id: r.recorded_event_id,
        replayed: r.replayed ?? false,
      },
      text: `Approval ${r.approval_id}: ${r.decision}`,
    };
  });
}
