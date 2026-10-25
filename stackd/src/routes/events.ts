// Events, the SSE relay, artifacts and lineage of a thread (BUILD.md §4.6).
import type { ExoEvent } from "@exos/exo-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ApiError, toProblem } from "../errors.ts";
import { viewOf } from "../events.ts";
import { listThreads, resolveThread, threadStatus } from "../threads.ts";

type Auth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Exo's event ids are opaque: any short token is accepted and Exo has the final say. */
const EVENT_ID = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "must be an event id");
const eventsQuery = z.strictObject({
  after: EVENT_ID.optional(),
  limit: z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .default(50),
  types: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(
      z
        .array(z.string().regex(/^[a-z0-9_.]{1,64}$/, "must be an event type"))
        .min(1)
        .max(20),
    )
    .optional(),
});
const streamQuery = z.strictObject({ after: EVENT_ID.optional() });
const artifactQuery = z.strictObject({
  version: z.string().regex(/^\d+$/).transform(Number).optional(),
});

const PAGE = 200;
const SCAN_LIMIT = 2_000;
const KEEP_ALIVE_MS = 15_000;

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  const pre = { preHandler: auth };
  const streams = new Set<AbortController>();
  app.addHook("onClose", async () => {
    for (const c of streams) c.abort();
  });

  app.get("/api/v1/threads/:agent/:thread/events", pre, async (request) => {
    const { agent: a, thread: t } = request.params as { agent: string; thread: string };
    const q = eventsQuery.parse(request.query ?? {});
    const { agent, thread } = await resolveThread(ctx, a, t);

    let events: ExoEvent[];
    let cursor = q.after;
    if (!q.types || q.types.length === 1) {
      events = await ctx.exo.listEvents(agent.id, thread.id, {
        after: q.after,
        limit: q.limit,
        ...(q.types ? { event_type: q.types[0] } : {}),
      });
      cursor = events.at(-1)?.id ?? q.after;
    } else {
      // Exo filters on one type: read pages and keep the matching ones.
      const wanted = new Set(q.types);
      events = [];
      let scanned = 0;
      for (;;) {
        const page = await ctx.exo.listEvents(agent.id, thread.id, { after: cursor, limit: PAGE });
        scanned += page.length;
        for (const e of page) {
          if (!wanted.has(e.type)) continue;
          events.push(e);
          if (events.length >= q.limit) break;
        }
        if (events.length >= q.limit) {
          cursor = events.at(-1)!.id;
          break;
        }
        cursor = page.at(-1)?.id ?? cursor;
        if (page.length < PAGE || scanned >= SCAN_LIMIT) break;
      }
    }
    const status = await threadStatus(ctx, agent, thread);
    return {
      events: events.map(viewOf),
      next_after: cursor ?? null,
      turn_active: status.active_turn_id !== null,
    };
  });

  app.get("/api/v1/threads/:agent/:thread/stream", pre, async (request, reply) => {
    const { agent: a, thread: t } = request.params as { agent: string; thread: string };
    const q = streamQuery.parse(request.query ?? {});
    const header = request.headers["last-event-id"];
    const lastEventId = Array.isArray(header) ? header[0] : header;
    const after = lastEventId ? EVENT_ID.parse(lastEventId) : q.after;
    const { agent, thread } = await resolveThread(ctx, a, t);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": stream open\n\n");
    const abort = new AbortController();
    streams.add(abort);
    request.raw.on("close", () => abort.abort());
    const timer = setInterval(() => res.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
    try {
      for await (const event of ctx.exo.watchEvents(agent.id, thread.id, {
        after,
        signal: abort.signal,
      })) {
        res.write(`id: ${event.id}\ndata: ${JSON.stringify(viewOf(event))}\n\n`);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        const p = toProblem(err) ?? {
          status: 500,
          code: "internal_error",
          title: "Internal error",
        };
        res.write(
          `event: stream_error\ndata: ${JSON.stringify({ code: p.code, title: p.title })}\n\n`,
        );
      }
    } finally {
      clearInterval(timer);
      streams.delete(abort);
      if (!res.writableEnded) res.end();
    }
  });

  app.get("/api/v1/threads/:agent/:thread/artifacts", pre, async (request) => {
    const { agent: a, thread: t } = request.params as { agent: string; thread: string };
    const { agent, thread } = await resolveThread(ctx, a, t);
    return { artifacts: await ctx.exo.listArtifacts(agent.id, thread.id) };
  });

  app.get("/api/v1/threads/:agent/:thread/artifacts/:name", pre, async (request) => {
    const {
      agent: a,
      thread: t,
      name,
    } = request.params as { agent: string; thread: string; name: string };
    const q = artifactQuery.parse(request.query ?? {});
    const { agent, thread } = await resolveThread(ctx, a, t);
    const art = await ctx.exo.readArtifact(agent.id, thread.id, { name, version: q.version });
    const content = typeof art.content === "string" ? art.content : "";
    return {
      name: typeof art.name === "string" ? art.name : name,
      version: typeof art.version === "number" ? art.version : (q.version ?? null),
      untrusted: true,
      untrusted_text: content,
    };
  });

  app.get("/api/v1/threads/:agent/:thread/lineage", pre, async (request) => {
    const { agent: a, thread: t } = request.params as { agent: string; thread: string };
    const { agent, thread } = await resolveThread(ctx, a, t);
    const all = await listThreads(ctx.exo, agent.id);
    if (all.length > 200)
      throw new ApiError(
        413,
        "too_many_threads",
        "Too many threads",
        "lineage scans at most 200 threads",
      );

    const forkedFrom = async (threadId: string) => {
      const [e] = await ctx.exo.listEvents(agent.id, threadId, {
        event_type: "thread_forked",
        limit: 1,
      });
      const raw = e as Record<string, unknown> | undefined;
      return typeof raw?.forked_from === "string"
        ? {
            from: raw.forked_from,
            at: typeof raw.forked_at_event_id === "string" ? raw.forked_at_event_id : null,
          }
        : null;
    };

    const own = await forkedFrom(thread.id);
    const source = own ? all.find((x) => x.id === own.from) : undefined;
    const children: Array<{
      thread_id: string;
      thread_slug: string;
      forked_at_event_id: string | null;
    }> = [];
    for (const other of all) {
      if (other.id === thread.id) continue;
      const f = await forkedFrom(other.id);
      if (f?.from === thread.id) {
        children.push({ thread_id: other.id, thread_slug: other.slug, forked_at_event_id: f.at });
      }
    }
    return {
      thread_id: thread.id,
      thread_slug: thread.slug,
      parent: own
        ? { thread_id: own.from, thread_slug: source?.slug ?? null, forked_at_event_id: own.at }
        : null,
      children,
    };
  });
}
