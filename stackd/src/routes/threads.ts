// stackd's threads and turns endpoints (BUILD.md §4.3 and §4.6). Order of a start: validate →
// idempotency → credit → worktree → Exo thread → first turn. stackd is the only Exo writer.
import { ExoHttpError, type ExoClient } from "@exos/exo-client";
import { sha256Hex } from "@exos/common";
import { askUserDeclaration } from "@exos/tools/ask-user";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { poolOf, type AgentInfo } from "../agents.ts";
import { bannerFor } from "../credit.ts";
import type { AppContext } from "../context.ts";
import { ApiError } from "../errors.ts";
import type { Json } from "../idempotency.ts";
import { asThread, listThreads, resolveThread, threadStatus } from "../threads.ts";

type Auth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const KEY = z.string().min(8).max(128);
const MESSAGE = z.string().min(1).max(20_000);

const startBody = z.strictObject({
  agent: z.string().min(1).max(128),
  prompt: MESSAGE,
  workspace: z.string().min(1).max(4096).optional(),
  resources: z
    .array(z.strictObject({ path: z.string().min(1).max(4096), mode: z.enum(["ro", "rw"]) }))
    .max(4)
    .optional(),
  thread_name: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  idempotency_key: KEY.optional(),
});
const sendBody = z.strictObject({ message: MESSAGE, idempotency_key: KEY.optional() });
const forkBody = z.strictObject({
  at: z.string().min(1).max(64).optional(),
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  idempotency_key: KEY.optional(),
});

/** The idempotency key from the header or the body; it is not part of the request that is hashed. */
function keyOf(request: FastifyRequest, fromBody: string | undefined): string {
  const header = request.headers["idempotency-key"];
  const key = (Array.isArray(header) ? header[0] : header) ?? fromBody;
  return KEY.parse(key ?? undefined);
}

/** `abc:fork` → ["abc", "fork"]; a plain `abc` → ["abc", undefined]. Slugs never contain a colon. */
function splitVerb(param: string): [string, string | undefined] {
  const at = param.lastIndexOf(":");
  return at < 0 ? [param, undefined] : [param.slice(0, at), param.slice(at + 1)];
}

const frontendTools = () => [askUserDeclaration];

const bannerField = (state: "ok" | "warn" | "stop"): { banner?: string } => {
  const banner = bannerFor(state);
  return banner ? { banner } : {};
};

/** The turn started by a request that crashed before it could be recorded, found in the event log. */
async function adoptActiveTurn(
  exo: ExoClient,
  agentId: string,
  threadId: string,
): Promise<{ turn_id: string; session_id: string } | undefined> {
  const [started] = await exo.listEvents(agentId, threadId, {
    direction: "desc",
    event_type: "turn_started",
    limit: 1,
  });
  const turnId = (started as Record<string, unknown> | undefined)?.turn_id;
  if (typeof turnId !== "string" || !(await exo.getTurn(agentId, threadId, turnId)).active)
    return undefined;
  const session = (started as Record<string, unknown>).session_id;
  return { turn_id: turnId, session_id: typeof session === "string" ? session : "" };
}

/** Submits a turn, adopting the one already running if this is a retry of a half-done request. */
async function submitTurn(
  ctx: AppContext,
  agent: AgentInfo,
  thread: { id: string; slug: string },
  input: string,
  adopt: boolean,
): Promise<{ turn_id: string; session_id: string }> {
  await ctx.supervisor.assertCapacity();
  const tracked = {
    agentId: agent.id,
    threadId: thread.id,
    threadSlug: thread.slug,
    pool: poolOf(agent),
  };
  try {
    const res = await ctx.exo.submitTurn(agent.id, thread.id, {
      input,
      frontend_tools: frontendTools(),
    });
    const turn = res.turn as string | { id: string; session_id?: string };
    const out =
      typeof turn === "string"
        ? { turn_id: turn, session_id: "" }
        : { turn_id: turn.id, session_id: turn.session_id ?? "" };
    ctx.supervisor.track(out.turn_id, tracked);
    return out;
  } catch (err) {
    if (adopt && err instanceof ExoHttpError && err.status === 409) {
      const adopted = await adoptActiveTurn(ctx.exo, agent.id, thread.id);
      if (adopted) {
        ctx.supervisor.track(adopted.turn_id, tracked);
        return adopted;
      }
    }
    throw err;
  }
}

export function registerThreadRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  const pre = { preHandler: auth };

  app.get("/api/v1/agents/:agent/threads", pre, async (request) => {
    const { agent: ref } = request.params as { agent: string };
    const agent = await ctx.agents.resolve(ref);
    return {
      agent_id: agent.id,
      threads: (await listThreads(ctx.exo, agent.id)).map((t) => ({
        ...t,
        dashboard_url: `${ctx.dashboardUrl}/threads/${agent.slug}/${t.slug}`,
      })),
    };
  });

  app.post("/api/v1/threads", pre, async (request, reply) => {
    const parsed = startBody.parse(request.body ?? {});
    const key = keyOf(request, parsed.idempotency_key);
    const { idempotency_key: _unused, ...body } = parsed;

    const { value, replayed } = await ctx.idem.run(
      key,
      "thread.start",
      body,
      async (progress, save) => {
        // A stopped pool is refused before any Exo request, using the agent as last seen.
        const seen = ctx.agents.peek(body.agent);
        if (seen) ctx.credit.assertCanSpend(seen);
        const known = await ctx.agents.list();
        const agent = known.find((a) => a.slug === body.agent || a.id === body.agent);
        if (!agent)
          throw new ApiError(404, "not_found", "Not found", `agent ${body.agent} not found`);
        ctx.credit.assertCanSpend(agent);

        const slug = `d-${sha256Hex(key).slice(0, 10)}`;
        for (const r of body.resources ?? []) ctx.worktrees.assertPathAllowed(r.path);
        let worktreePath = progress.worktree_path as string | undefined;
        if (body.workspace && !worktreePath) {
          worktreePath = (
            await ctx.worktrees.create({ threadSlug: slug, workspace: body.workspace })
          ).worktree_path;
          save({ worktree_path: worktreePath });
        }

        let threadId = progress.thread_id as string | undefined;
        if (!threadId) {
          const created = await ctx.exo.createThread(
            agent.id,
            {
              ...(agent.environment ? { environment: agent.environment } : {}),
              vaults: agent.vaults,
              thread_slug: slug,
              ...(body.thread_name ? { thread_name: body.thread_name } : {}),
            },
            { idempotent: true },
          );
          threadId = String((created.thread as Record<string, unknown>).id);
          save({ thread_id: threadId });
        }

        let turnId = progress.turn_id as string | undefined;
        let sessionId = progress.session_id as string | undefined;
        if (!turnId) {
          const turn = await submitTurn(ctx, agent, { id: threadId, slug }, body.prompt, true);
          turnId = turn.turn_id;
          sessionId = turn.session_id;
          save({ turn_id: turnId, session_id: sessionId });
        }

        ctx.audit("thread.start", slug, {
          agent: agent.slug,
          thread_id: threadId,
          turn_id: turnId,
          workspace: body.workspace ?? null,
          resources: body.resources ?? [],
          prompt_chars: body.prompt.length,
          prompt_sha256: sha256Hex(body.prompt),
        });
        return {
          agent_id: agent.id,
          thread_id: threadId,
          thread_slug: slug,
          turn_id: turnId,
          session_id: sessionId ?? "",
          ...(worktreePath ? { worktree_path: worktreePath } : {}),
          dashboard_url: `${ctx.dashboardUrl}/threads/${agent.slug}/${slug}`,
          credit_state: ctx.credit.state(poolOf(agent)),
          ...bannerField(ctx.credit.state(poolOf(agent))),
        } satisfies Json;
      },
    );
    return reply.code(replayed ? 200 : 201).send({ ...value, replayed });
  });

  // GET /threads/resolve?thread=<agent>/<thread> | <slug or id>: who a thread reference means.
  app.get("/api/v1/threads/resolve", pre, async (request) => {
    const { thread: ref } = z
      .strictObject({ thread: z.string().min(1).max(257) })
      .parse(request.query ?? {});
    const matches: Array<{
      agent_id: string;
      agent_slug: string;
      thread_id: string;
      thread_slug: string;
    }> = [];
    const slash = ref.indexOf("/");
    const agents = await ctx.agents.list();
    for (const agent of agents) {
      if (slash >= 0 && agent.slug !== ref.slice(0, slash) && agent.id !== ref.slice(0, slash))
        continue;
      const wanted = slash >= 0 ? ref.slice(slash + 1) : ref;
      for (const t of await listThreads(ctx.exo, agent.id)) {
        if (t.slug === wanted || t.id === wanted) {
          matches.push({
            agent_id: agent.id,
            agent_slug: agent.slug,
            thread_id: t.id,
            thread_slug: t.slug,
          });
        }
      }
    }
    return { matches };
  });

  app.get("/api/v1/threads/:agent/:thread", pre, async (request) => {
    const { agent: a, thread: t } = request.params as { agent: string; thread: string };
    const { agent, thread } = await resolveThread(ctx, a, t);
    return {
      ...(await threadStatus(ctx, agent, thread)),
      dashboard_url: `${ctx.dashboardUrl}/threads/${agent.slug}/${thread.slug}`,
    };
  });

  // POST /threads/{agent}/{thread}:fork
  app.post("/api/v1/threads/:agent/:thread", pre, async (request, reply) => {
    const { agent: a, thread: raw } = request.params as { agent: string; thread: string };
    const [t, verb] = splitVerb(raw);
    if (verb !== "fork") throw new ApiError(404, "not_found", "Not found", "unknown thread action");
    const parsed = forkBody.parse(request.body ?? {});
    const key = keyOf(request, parsed.idempotency_key);
    const { idempotency_key: _unused, ...body } = parsed;
    if (body.at !== undefined) {
      throw new ApiError(
        400,
        "fork_at_unsupported",
        "Fork at an event is unsupported",
        "forking at an event needs Exo's `--up-to`, which is not available over HTTP (V-4)",
      );
    }
    const { value, replayed } = await ctx.idem.run(
      key,
      "thread.fork",
      { ...body, thread: t, agent: a },
      async () => {
        const early = ctx.agents.peek(a);
        if (early) ctx.credit.assertCanSpend(early);
        const { agent, thread } = await resolveThread(ctx, a, t);
        ctx.credit.assertCanSpend(agent);
        const forked = await ctx.exo.forkThread(
          agent.id,
          thread.id,
          body.name ? { thread_name: body.name } : {},
        );
        const info = asThread(forked.thread as Record<string, unknown>);
        ctx.audit("thread.fork", info.slug, { agent: agent.slug, forked_from: thread.slug });
        return {
          thread_id: info.id,
          thread_slug: info.slug,
          forked_from: thread.slug,
        } satisfies Json;
      },
    );
    return reply.code(replayed ? 200 : 201).send({ ...value, replayed });
  });

  app.post("/api/v1/threads/:agent/:thread/turns", pre, async (request, reply) => {
    const { agent: a, thread: t } = request.params as { agent: string; thread: string };
    const parsed = sendBody.parse(request.body ?? {});
    const key = keyOf(request, parsed.idempotency_key);
    const { idempotency_key: _unused, ...body } = parsed;
    const { value, replayed } = await ctx.idem.run(
      key,
      "turn.send",
      { ...body, thread: t, agent: a },
      async (progress, save) => {
        const early = ctx.agents.peek(a);
        if (early) ctx.credit.assertCanSpend(early);
        const { agent, thread } = await resolveThread(ctx, a, t);
        ctx.credit.assertCanSpend(agent);
        let turnId = progress.turn_id as string | undefined;
        let sessionId = progress.session_id as string | undefined;
        if (!turnId) {
          const turn = await submitTurn(ctx, agent, thread, body.message, false);
          turnId = turn.turn_id;
          sessionId = turn.session_id;
          save({ turn_id: turnId, session_id: sessionId });
        }
        ctx.audit("turn.send", thread.slug, {
          agent: agent.slug,
          turn_id: turnId,
          message_chars: body.message.length,
          message_sha256: sha256Hex(body.message),
        });
        const creditState = ctx.credit.state(poolOf(agent));
        return {
          turn_id: turnId,
          session_id: sessionId ?? "",
          credit_state: creditState,
          ...bannerField(creditState),
        } satisfies Json;
      },
    );
    return reply.code(replayed ? 200 : 201).send({ ...value, replayed });
  });

  // POST /threads/{agent}/{thread}/turns/{turn}:cancel
  app.post("/api/v1/threads/:agent/:thread/turns/:turn", pre, async (request) => {
    const {
      agent: a,
      thread: t,
      turn: rawTurn,
    } = request.params as { agent: string; thread: string; turn: string };
    const [turnId, verb] = splitVerb(rawTurn);
    if (verb !== "cancel") throw new ApiError(404, "not_found", "Not found", "unknown turn action");
    const { agent, thread } = await resolveThread(ctx, a, t);
    const res = await ctx.exo.cancelTurn(agent.id, thread.id, turnId);
    ctx.audit("turn.cancel", thread.slug, {
      agent: agent.slug,
      turn_id: turnId,
      canceled: res.canceled_active_turn,
    });
    return res;
  });
}
