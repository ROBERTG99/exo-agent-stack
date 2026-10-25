// The approvals queue (BUILD.md §4.6, FR-11): list, decide, and answer client-tool questions.
import { ExoHttpError } from "@exos/exo-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isOpen, type ApprovalQueue, type ApprovalRow, type Decision } from "../approvals.ts";
import type { AppContext } from "../context.ts";
import { ApiError, notFound } from "../errors.ts";
import type { Json } from "../idempotency.ts";
import { sha256Hex } from "@exos/common";

type Auth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const KEY = z.string().min(8).max(128);
const listQuery = z.strictObject({
  state: z.enum(["open", "decided", "all"]).default("open"),
  thread: z.string().min(1).max(128).optional(),
});
const decideBody = z.strictObject({
  decision: z.enum(["approve", "deny", "approve_for_session"]),
  reason: z.string().max(500).optional(),
  idempotency_key: KEY.optional(),
});
const answerBody = z.strictObject({
  answer: z.string().min(1).max(8000),
  /** The thread id or slug; with `agent` it is unambiguous. */
  thread: z.string().min(1).max(128).optional(),
  agent: z.string().min(1).max(128).optional(),
  idempotency_key: KEY.optional(),
});

const STORED: Record<
  "approve" | "deny" | "approve_for_session",
  Exclude<Decision, "pending" | "dashboard_only">
> = {
  approve: "approved",
  deny: "denied",
  approve_for_session: "approved_for_session",
};

function splitVerb(param: string): [string, string | undefined] {
  const at = param.lastIndexOf(":");
  return at < 0 ? [param, undefined] : [param.slice(0, at), param.slice(at + 1)];
}

function viewOf(ctx: AppContext, r: ApprovalRow) {
  const agent = ctx.agents.peek(r.agent_id);
  return {
    approval_id: r.approval_id,
    kind: r.kind,
    agent_id: r.agent_id,
    agent: agent?.slug ?? null,
    thread_id: r.thread_id,
    thread_slug: r.thread_slug,
    turn_id: r.turn_id,
    call_id: r.call_id,
    tool: r.tool,
    args: JSON.parse(r.args_redacted) as unknown,
    decision: r.decision,
    dashboard_only: r.decision === "dashboard_only",
    decided_by: r.decided_by,
    requested_at: r.requested_at,
    decided_at: r.decided_at,
    ...(r.untrusted_text ? { untrusted_text: r.untrusted_text } : {}),
    dashboard_url: `${ctx.dashboardUrl}/threads/${agent?.slug ?? r.agent_id}/${r.thread_slug}`,
  };
}

/** Exo refused because the request is already answered or its turn is over. */
const closedInExo = (err: unknown): boolean =>
  err instanceof ExoHttpError && (err.status === 409 || err.status === 404);

export function registerApprovalRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  queue: ApprovalQueue,
  auth: Auth,
): void {
  const pre = { preHandler: auth };

  /** Reads Exo's log into the queue; if Exo is down the queue shows what it last knew. */
  async function syncQuietly(): Promise<boolean> {
    try {
      await queue.sync();
      return false;
    } catch {
      return true;
    }
  }

  async function latestEventId(
    agentId: string,
    threadId: string,
    type: string,
  ): Promise<string | null> {
    const [e] = await ctx.exo.listEvents(agentId, threadId, {
      direction: "desc",
      event_type: type,
      limit: 1,
    });
    return e?.id ?? null;
  }

  app.get("/api/v1/approvals", pre, async (request) => {
    const q = listQuery.parse(request.query ?? {});
    const stale = await syncQuietly();
    return {
      approvals: queue.list({ state: q.state, thread: q.thread }).map((r) => viewOf(ctx, r)),
      dashboard_only_tools: queue.patterns,
      stale,
    };
  });

  // POST /approvals/{id}:decide
  app.post("/api/v1/approvals/:id", pre, async (request, reply) => {
    const [id, verb] = splitVerb((request.params as { id: string }).id);
    if (verb !== "decide")
      throw new ApiError(404, "not_found", "Not found", "unknown approval action");
    const parsed = decideBody.parse(request.body ?? {});
    const { idempotency_key: fromBody, ...body } = parsed;
    const header = request.headers["idempotency-key"];
    const key = (Array.isArray(header) ? header[0] : header) ?? fromBody;
    const actor = request.actor ?? "api";

    const decide = async (
      progress: Json = {},
      save: (more: Json) => void = () => undefined,
    ): Promise<Json> => {
      if (typeof progress.decision === "string") {
        // an earlier attempt got the answer into Exo; only the reply was lost
        const done = queue.get(id);
        return {
          approval_id: id,
          decision: progress.decision,
          recorded_event_id: done
            ? await latestEventId(done.agent_id, done.thread_id, "agent_runtime.approval_response")
            : null,
        };
      }
      let row = queue.get(id);
      if (!row) {
        await syncQuietly();
        row = queue.get(id);
      }
      if (!row) throw notFound(`approval ${id}`);
      if (row.kind !== "approval") {
        throw new ApiError(
          400,
          "invalid_input",
          "Invalid input",
          "this is a question for the human: answer it with frontend-tools",
        );
      }
      if (!isOpen(row.decision)) {
        throw new ApiError(
          409,
          "already_decided",
          "Already decided",
          `approval ${id} is already ${row.decision}`,
        );
      }
      if (row.decision === "dashboard_only") {
        if (actor !== "dashboard") {
          ctx.audit(
            "approval.refused_dashboard_only",
            id,
            { tool: row.tool, thread: row.thread_slug },
            actor,
          );
          throw new ApiError(
            403,
            "dashboard_only",
            "Dashboard only",
            `${row.tool} can only be approved in the dashboard`,
          );
        }
        if (body.decision === "approve_for_session") {
          throw new ApiError(
            400,
            "invalid_input",
            "Invalid input",
            "a dashboard-only tool cannot be approved for the whole session",
          );
        }
      }
      const previous = row.decision;
      const stored = STORED[body.decision];
      if (!queue.claim(id, stored, actor)) {
        throw new ApiError(
          409,
          "already_decided",
          "Already decided",
          `approval ${id} was decided just now`,
        );
      }
      try {
        await ctx.exo.respondApproval(row.agent_id, row.thread_id, row.turn_id, {
          session_id: row.session_id,
          approval_id: id,
          approved: body.decision !== "deny",
          allow_for_tool: body.decision === "approve_for_session",
        });
      } catch (err) {
        queue.release(id, previous);
        if (closedInExo(err)) {
          throw new ApiError(
            409,
            "already_decided",
            "Already decided",
            "Exo no longer accepts an answer for this request",
          );
        }
        throw err;
      }
      save({ decision: stored });
      ctx.audit(
        "approval.decide",
        id,
        { decision: stored, tool: row.tool, thread: row.thread_slug, reason: body.reason ?? null },
        actor,
      );
      return {
        approval_id: id,
        decision: stored,
        recorded_event_id: await latestEventId(
          row.agent_id,
          row.thread_id,
          "agent_runtime.approval_response",
        ),
      };
    };

    if (!key) return reply.send(await decide());
    const { value, replayed } = await ctx.idem.run(
      KEY.parse(key),
      "approval.decide",
      { id, ...body },
      (progress, save) => decide(progress, save),
    );
    return reply.send({ ...value, replayed });
  });

  // POST /frontend-tools/{tool_call_id}:answer
  app.post("/api/v1/frontend-tools/:id", pre, async (request, reply) => {
    const [callId, verb] = splitVerb((request.params as { id: string }).id);
    if (verb !== "answer") throw new ApiError(404, "not_found", "Not found", "unknown action");
    const parsed = answerBody.parse(request.body ?? {});
    const { idempotency_key: fromBody, ...body } = parsed;
    const header = request.headers["idempotency-key"];
    const key = (Array.isArray(header) ? header[0] : header) ?? fromBody;
    const actor = request.actor ?? "api";

    const answer = async (
      progress: Json = {},
      save: (more: Json) => void = () => undefined,
    ): Promise<Json> => {
      if (progress.answered === true) {
        const done = queue.frontendAnswered(callId, body.thread, body.agent);
        return {
          recorded_event_id: done
            ? await latestEventId(done.agent_id, done.thread_id, "frontend_tool_result")
            : null,
        };
      }
      let rows = queue.frontendByCall(callId, body.thread, body.agent);
      if (rows.length === 0) {
        await syncQuietly();
        rows = queue.frontendByCall(callId, body.thread, body.agent);
      }
      if (rows.length === 0) throw notFound(`open question ${callId}`);
      if (rows.length > 1) {
        throw new ApiError(
          409,
          "ambiguous_thread",
          "Ambiguous",
          "several threads have an open question with this id: pass `thread`",
        );
      }
      const row = rows[0]!;
      if (!queue.claim(row.approval_id, "approved", actor)) {
        throw new ApiError(
          409,
          "already_decided",
          "Already decided",
          "this question was answered just now",
        );
      }
      try {
        await ctx.exo.sendFrontendToolResult(row.agent_id, row.thread_id, row.turn_id, {
          session_id: row.session_id,
          tool_call_id: row.call_id,
          result: { type: "frontend_tool_success", output: body.answer },
        });
      } catch (err) {
        queue.release(row.approval_id, "pending");
        if (closedInExo(err)) {
          throw new ApiError(
            409,
            "already_decided",
            "Already decided",
            "Exo no longer accepts an answer for this question",
          );
        }
        throw err;
      }
      save({ answered: true });
      ctx.audit(
        "frontend_tool.answer",
        row.approval_id,
        {
          thread: row.thread_slug,
          answer_chars: body.answer.length,
          answer_sha256: sha256Hex(body.answer),
        },
        actor,
      );
      return {
        recorded_event_id: await latestEventId(row.agent_id, row.thread_id, "frontend_tool_result"),
      };
    };

    if (!key) return reply.send(await answer());
    const { value, replayed } = await ctx.idem.run(
      KEY.parse(key),
      "frontend_tool.answer",
      { callId, ...body },
      (progress, save) => answer(progress, save),
    );
    return reply.send({ ...value, replayed });
  });
}
