// The Exo simulator's HTTP API: the §4.2 surface of BUILD.md under /exo, backed by SQLite and the
// turn runner. It is a stand-in for offline runs (default compose stack, end-to-end tests,
// durability suite). Its request and response shapes are the ones the client in
// packages/exo-client assumes; both are unverified against the real Exo (V-6, V-11 and the rest of
// docs/exo-verification.md), and it runs the scripted harness for every agent whatever the agent
// declares.
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { join } from "node:path";
import { TurnRunner } from "./runner.ts";
import { Store, type AgentRow, type ThreadRow } from "./store.ts";

export interface ExoSimOptions {
  dataDir: string;
  modelUrl: string;
  stepDelayMs?: number;
  ledgerPath?: string;
  pollMs?: number;
}

export interface ExoSim {
  app: FastifyInstance;
  store: Store;
  runner: TurnRunner;
  /** Stops the server and the runners cleanly. */
  close(): Promise<void>;
  /** Drops everything in flight without writing, like a SIGKILL (then call `abandon`). */
  crash(): void;
  /** Releases the database handle after a crash so another instance can open it. */
  abandon(): Promise<void>;
}

type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

const threadJson = (t: ThreadRow) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  agent_id: t.agent_id,
  environment: t.environment,
  harness: t.harness,
});
const agentJson = (a: AgentRow) => ({
  id: a.id,
  slug: a.slug,
  name: a.slug,
  harness: (a.body.definition as Json | undefined)?.harness ?? null,
});

export async function createExoSim(opts: ExoSimOptions): Promise<ExoSim> {
  const store = new Store(join(opts.dataDir, "exo-sim.db"));
  const runner = new TurnRunner({
    store,
    modelUrl: opts.modelUrl,
    stepDelayMs: opts.stepDelayMs,
    ledgerPath: opts.ledgerPath,
    pollMs: opts.pollMs,
  });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const streams = new Set<{ end(): void }>();
  app.addHook("onClose", async () => {
    for (const s of streams) s.end();
  });

  // --- agents ---------------------------------------------------------------------------------

  app.get("/exo/agent", async (req) => {
    const slug = (req.query as { slug?: string }).slug;
    return {
      agents: store
        .listAgents()
        .filter((a) => !slug || a.slug === slug)
        .map(agentJson),
    };
  });

  app.post("/exo/agent/managed", async (req, reply) => {
    const body = req.body as Json | null;
    const slug = body && typeof body.slug === "string" ? body.slug : "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      return fail(reply, 400, "invalid_request", "slug is required");
    if (store.agent(slug)) return fail(reply, 409, "agent_exists", `agent ${slug} already exists`);
    const a = store.createAgent(slug, body!);
    return { agent: { id: a.id, slug: a.slug } };
  });

  app.put<{ Params: { a: string } }>("/exo/agent/:a/definition", async (req, reply) => {
    const a = store.agent(req.params.a);
    if (!a) return fail(reply, 404, "not_found", "unknown agent");
    store.updateAgent(a.id, { ...(req.body as Json), slug: a.slug });
    return { agent: { id: a.id, slug: a.slug } };
  });

  app.get<{ Params: { a: string } }>("/exo/agent/:a/doctor", async (req, reply) => {
    const a = store.agent(req.params.a);
    if (!a) return fail(reply, 404, "not_found", "unknown agent");
    return { ok: true, checks: [{ name: "definition", status: "pass" }] };
  });

  // --- threads --------------------------------------------------------------------------------

  app.get<{ Params: { a: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/exo/agent/:a/thread",
    async (req, reply) => {
      const a = store.agent(req.params.a);
      if (!a) return fail(reply, 404, "not_found", "unknown agent");
      const page = store.listThreads(
        a.id,
        Number(req.query.cursor ?? 0) || 0,
        Math.max(1, Math.min(Number(req.query.limit ?? 50) || 50, 200)),
      );
      return {
        threads: page.threads.map(threadJson),
        next_cursor: page.next === null ? null : String(page.next),
      };
    },
  );

  app.post<{ Params: { a: string } }>("/exo/agent/:a/thread", async (req, reply) => {
    const a = store.agent(req.params.a);
    if (!a) return fail(reply, 404, "not_found", "unknown agent");
    const b = (req.body ?? {}) as Json;
    const { thread, created } = store.createThread(a.id, {
      slug: typeof b.thread_slug === "string" ? b.thread_slug : undefined,
      name: typeof b.thread_name === "string" ? b.thread_name : undefined,
      environment: typeof b.environment === "string" ? b.environment : undefined,
      harness: typeof b.harness === "string" ? b.harness : undefined,
      model: b.model,
    });
    if (created)
      store.addEvent(thread.id, {
        type: "thread_created",
        payload: { slug: thread.slug, name: thread.name, environment: thread.environment },
      });
    return {
      agent: { id: a.id, slug: a.slug },
      thread: threadJson(thread),
      harness: thread.harness ?? (a.body.definition as Json | undefined)?.harness ?? null,
    };
  });

  const resolve = (
    reply: FastifyReply,
    agentRef: string,
    threadRef: string,
  ): { a: AgentRow; t: ThreadRow } | null => {
    const a = store.agent(agentRef);
    if (!a) {
      void fail(reply, 404, "not_found", "unknown agent");
      return null;
    }
    const t = store.thread(a.id, threadRef);
    if (!t) {
      void fail(reply, 404, "not_found", "unknown thread");
      return null;
    }
    return { a, t };
  };

  // --- turns ----------------------------------------------------------------------------------

  app.post<{ Params: { a: string; t: string } }>(
    "/exo/agent/:a/thread/:t/turn",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const b = (req.body ?? {}) as Json;
      if (typeof b.input !== "string" || b.input === "")
        return fail(reply, 400, "invalid_request", "input is required");
      if (store.activeTurn(r.t.id))
        return fail(reply, 409, "turn_active", "the thread already has an active turn");
      // One unit: a turn row without its opening events would block the thread forever.
      const turn = store.atomic(() => {
        const created = store.createTurn({
          thread_id: r.t.id,
          session_id: typeof b.session_id === "string" ? b.session_id : undefined,
          input: b.input as string,
          frontend_tools: Array.isArray(b.frontend_tools) ? b.frontend_tools : [],
          auto_approve_tools: Array.isArray(b.auto_approve_tools)
            ? b.auto_approve_tools.map(String)
            : [],
        });
        const known = store.db
          .prepare(
            "SELECT 1 FROM events WHERE thread_id = ? AND session_id = ? AND type = 'session_started' LIMIT 1",
          )
          .get(r.t.id, created.session_id);
        if (!known)
          store.addEvent(r.t.id, { type: "session_started", session_id: created.session_id });
        store.addEvent(r.t.id, {
          type: "turn_started",
          session_id: created.session_id,
          turn_id: created.id,
        });
        store.addEvent(r.t.id, {
          type: "messages",
          session_id: created.session_id,
          turn_id: created.id,
          payload: { role: "user", text: b.input },
        });
        return created;
      });
      runner.start(turn);
      return {
        agent: { id: r.a.id, slug: r.a.slug },
        thread: threadJson(r.t),
        turn: { id: turn.id, session_id: turn.session_id },
        harness: r.t.harness ?? null,
      };
    },
  );

  app.get<{ Params: { a: string; t: string; turn: string } }>(
    "/exo/agent/:a/thread/:t/turn/:turn",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const turn = store.turn(req.params.turn);
      if (!turn || turn.thread_id !== r.t.id) return fail(reply, 404, "not_found", "unknown turn");
      return { active: turn.status === "running" };
    },
  );

  app.post<{ Params: { a: string; t: string; turn: string } }>(
    "/exo/agent/:a/thread/:t/turn/:turn/cancel",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const turn = store.turn(req.params.turn);
      if (!turn || turn.thread_id !== r.t.id) return fail(reply, 404, "not_found", "unknown turn");
      const canceled = await runner.cancel(turn.id);
      const ended = store.events(r.t.id, {
        turn_id: turn.id,
        event_type: "turn_ended",
        direction: "desc",
        limit: 1,
      })[0];
      return { canceled_active_turn: canceled, finished_event_id: ended?.id ?? null };
    },
  );

  app.post<{ Params: { a: string; t: string; turn: string } }>(
    "/exo/agent/:a/thread/:t/turn/:turn/approval-response",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const b = (req.body ?? {}) as Json;
      const p = typeof b.approval_id === "string" ? store.pending(b.approval_id) : undefined;
      if (!p || p.kind !== "approval" || p.thread_id !== r.t.id || p.turn_id !== req.params.turn)
        return fail(reply, 404, "not_found", "unknown approval");
      if (typeof b.approved !== "boolean")
        return fail(reply, 400, "invalid_request", "approved must be a boolean");
      if (!store.decide(p.id, { approved: b.approved, allow_for_tool: b.allow_for_tool === true }))
        return fail(reply, 409, "already_decided", "the approval was already decided");
      store.addEvent(r.t.id, {
        type: "agent_runtime.approval_response",
        session_id: p.session_id,
        turn_id: p.turn_id,
        payload: {
          approval_id: p.id,
          approved: b.approved,
          allow_for_tool: b.allow_for_tool === true,
        },
      });
      return {};
    },
  );

  app.post<{ Params: { a: string; t: string; turn: string } }>(
    "/exo/agent/:a/thread/:t/turn/:turn/frontend-tool-result",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const b = (req.body ?? {}) as Json;
      const p =
        typeof b.tool_call_id === "string"
          ? store.pendingByCall("frontend", r.t.id, b.tool_call_id)
          : undefined;
      if (!p || p.turn_id !== req.params.turn)
        return fail(reply, 404, "not_found", "unknown frontend tool call");
      const result = (b.result ?? {}) as Json;
      if (result.type !== "frontend_tool_success")
        return fail(reply, 400, "invalid_request", "result.type must be frontend_tool_success");
      if (!store.decide(p.id, { output: result.output }))
        return fail(reply, 409, "already_decided", "the tool call already has a result");
      store.addEvent(r.t.id, {
        type: "frontend_tool_result",
        session_id: p.session_id,
        turn_id: p.turn_id,
        payload: { tool_call_id: p.call_id, call_id: p.call_id },
      });
      return {};
    },
  );

  // --- events ---------------------------------------------------------------------------------

  app.get<{ Params: { a: string; t: string }; Querystring: Record<string, string> }>(
    "/exo/agent/:a/thread/:t/event",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const q = req.query;
      const whole = (v: string | undefined) =>
        v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : NaN;
      const limit = whole(q.limit);
      if (limit !== undefined && !(limit >= 1))
        return fail(reply, 400, "invalid_request", "limit must be a positive integer");
      if (q.after !== undefined && Number.isNaN(whole(q.after)))
        return fail(reply, 400, "invalid_request", "after must be an event id");
      return {
        events: store.events(r.t.id, {
          session_id: q.session_id,
          turn_id: q.turn_id,
          after: q.after,
          event_type: q.event_type,
          limit,
          direction: q.direction === "desc" ? "desc" : "asc",
        }),
      };
    },
  );

  app.get<{ Params: { a: string; t: string }; Querystring: { after?: string } }>(
    "/exo/agent/:a/thread/:t/event/watch",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      let cursor = Number(req.query.after ?? 0) || 0;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let open = true;
      const handle = { end: () => ((open = false), res.end()) };
      streams.add(handle);
      req.raw.on("close", () => (open = false));
      let quiet = 0;
      while (open) {
        const batch = store.events(r.t.id, { after: String(cursor), limit: 200 });
        for (const e of batch) {
          res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = Number(e.id);
        }
        if (batch.length === 0 && ++quiet % 400 === 0) res.write(": keep-alive\n\n");
        if (batch.length > 0) quiet = 0;
        await sleep(25);
      }
      streams.delete(handle);
      if (!res.writableEnded) res.end();
    },
  );

  // --- fork, artifacts, previews --------------------------------------------------------------

  app.post<{ Params: { a: string; t: string } }>(
    "/exo/agent/:a/thread/:t/fork",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const b = (req.body ?? {}) as Json;
      const forked = store.forkThread(r.a.id, r.t.id, {
        name: typeof b.thread_name === "string" ? b.thread_name : undefined,
      });
      return { thread: threadJson(forked) };
    },
  );

  app.get<{ Params: { a: string; t: string } }>(
    "/exo/agent/:a/thread/:t/artifact",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      return { artifacts: store.listArtifacts(r.t.id) };
    },
  );

  app.get<{ Params: { a: string; t: string }; Querystring: { name?: string; version?: string } }>(
    "/exo/agent/:a/thread/:t/artifact/read",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      const name = req.query.name;
      if (!name) return fail(reply, 400, "invalid_request", "name is required");
      const art = store.readArtifact(
        r.t.id,
        name,
        req.query.version ? Number(req.query.version) : undefined,
      );
      return art ?? fail(reply, 404, "not_found", "unknown artifact");
    },
  );

  app.get<{ Params: { a: string; t: string } }>(
    "/exo/agent/:a/thread/:t/previews",
    async (req, reply) => {
      const r = resolve(reply, req.params.a, req.params.t);
      if (!r) return;
      return null;
    },
  );

  runner.recover();

  return {
    app,
    store,
    runner,
    close: async () => {
      runner.crash();
      await runner.whenIdle();
      await app.close();
      store.close();
    },
    crash: () => runner.crash(),
    abandon: async () => {
      await runner.whenIdle();
      await app.close();
      store.close();
    },
  };
}
