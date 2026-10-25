import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExoClient,
  ExoHttpError,
  ExoProtocolError,
  ExoUnavailableError,
  parseEvent,
  usageOf,
} from "../src/index.ts";
import { json, startStub, type Handler } from "./stub.ts";

const stubs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

async function setup(
  handler: Handler,
  opts: ConstructorParameters<typeof ExoClient>[0] extends infer O ? Partial<O> : never = {},
) {
  const stub = await startStub(handler);
  stubs.push(stub);
  const sleeps: number[] = [];
  const client = new ExoClient({
    baseUrl: stub.baseUrl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...opts,
  });
  return { client, stub, sleeps };
}

describe("endpoints (BUILD.md §4.2)", () => {
  it("lists agents, optionally by slug", async () => {
    const { client, stub } = await setup((_c, res) =>
      json(res, { agents: [{ id: "a1", slug: "repo-builder" }] }),
    );
    expect(await client.listAgents()).toEqual([{ id: "a1", slug: "repo-builder" }]);
    await client.listAgents({ slug: "repo-builder" });
    expect(stub.calls[0]).toMatchObject({ method: "GET", path: "/exo/agent", query: {} });
    expect(stub.calls[1]!.query).toEqual({ slug: "repo-builder" });
  });

  it("creates a thread with the documented body", async () => {
    const { client, stub } = await setup((_c, res) =>
      json(res, {
        agent: { id: "a1" },
        thread: { id: "t1", slug: "d-abc" },
        harness: "claude-host",
      }),
    );
    const out = await client.createThread("a1", {
      environment: "host-a",
      vaults: [],
      thread_slug: "d-abc",
      thread_name: "demo",
    });
    expect(out.thread).toMatchObject({ slug: "d-abc" });
    expect(stub.calls[0]).toMatchObject({ method: "POST", path: "/exo/agent/a1/thread" });
    expect(stub.calls[0]!.body).toEqual({
      environment: "host-a",
      vaults: [],
      thread_slug: "d-abc",
      thread_name: "demo",
    });
  });

  it("submits a turn with frontend tools and returns the turn", async () => {
    const { client, stub } = await setup((_c, res) =>
      json(res, { agent: {}, thread: {}, turn: { id: "turn-1" }, harness: "h" }),
    );
    const out = await client.submitTurn("a1", "t1", {
      input: "hello",
      frontend_tools: [{ name: "ask_user" }],
      auto_approve_tools: [],
    });
    expect(ExoClient.turnId(out)).toBe("turn-1");
    expect(stub.calls[0]).toMatchObject({ method: "POST", path: "/exo/agent/a1/thread/t1/turn" });
    expect(stub.calls[0]!.body).toMatchObject({
      input: "hello",
      frontend_tools: [{ name: "ask_user" }],
    });
  });

  it("reads, cancels and answers turns", async () => {
    const { client, stub } = await setup((c, res) => {
      if (c.path.endsWith("/cancel"))
        return json(res, { canceled_active_turn: true, finished_event_id: "e9" });
      if (c.path.endsWith("/approval-response") || c.path.endsWith("/frontend-tool-result"))
        return json(res, {});
      return json(res, { active: true });
    });
    expect(await client.getTurn("a1", "t1", "u1")).toEqual({ active: true });
    expect(await client.cancelTurn("a1", "t1", "u1")).toEqual({
      canceled_active_turn: true,
      finished_event_id: "e9",
    });
    await client.respondApproval("a1", "t1", "u1", {
      session_id: "s1",
      approval_id: "ap1",
      approved: true,
      allow_for_tool: false,
    });
    await client.sendFrontendToolResult("a1", "t1", "u1", {
      session_id: "s1",
      tool_call_id: "tc1",
      result: { type: "frontend_tool_success", output: "yes" },
    });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /exo/agent/a1/thread/t1/turn/u1",
      "POST /exo/agent/a1/thread/t1/turn/u1/cancel",
      "POST /exo/agent/a1/thread/t1/turn/u1/approval-response",
      "POST /exo/agent/a1/thread/t1/turn/u1/frontend-tool-result",
    ]);
    expect(stub.calls[3]!.body).toEqual({
      session_id: "s1",
      tool_call_id: "tc1",
      result: { type: "frontend_tool_success", output: "yes" },
    });
  });

  it("lists events with every documented query parameter and keeps unknown types", async () => {
    const { client, stub } = await setup((_c, res) =>
      json(res, {
        events: [
          { id: "e1", type: "turn_started" },
          { id: "e2", type: "brand_new_type", extra: 1 },
        ],
      }),
    );
    const events = await client.listEvents("a1", "t1", {
      session_id: "s1",
      turn_id: "u1",
      after: "e0",
      limit: 50,
      direction: "asc",
      event_type: "messages",
    });
    expect(events.map((e) => e.type)).toEqual(["turn_started", "brand_new_type"]);
    expect(events[1]).toMatchObject({ extra: 1 });
    expect(stub.calls[0]!.query).toEqual({
      session_id: "s1",
      turn_id: "u1",
      after: "e0",
      limit: "50",
      direction: "asc",
      event_type: "messages",
    });
  });

  it("forks, lists threads, artifacts and previews", async () => {
    const { client, stub } = await setup((c, res) => {
      if (c.path.endsWith("/previews")) return json(res, null);
      if (c.path.endsWith("/artifact/read"))
        return json(res, { name: "r", version: 2, content: "# hi" });
      if (c.path.endsWith("/artifact"))
        return json(res, { artifacts: [{ name: "r", version: 2 }] });
      if (c.path.endsWith("/fork")) return json(res, { thread: { id: "t2", slug: "forked" } });
      return json(res, { threads: [{ id: "t1" }], next_cursor: "c2" });
    });
    expect((await client.listThreads("a1", { cursor: "c1", limit: 10 })).threads).toHaveLength(1);
    expect((await client.forkThread("a1", "t1", { thread_name: "alt" })).thread).toMatchObject({
      slug: "forked",
    });
    expect(await client.listArtifacts("a1", "t1")).toEqual([{ name: "r", version: 2 }]);
    expect(await client.readArtifact("a1", "t1", { name: "r", version: 2 })).toMatchObject({
      content: "# hi",
    });
    expect(await client.getPreviews("a1", "t1")).toBeNull();
    expect(stub.calls[0]!.query).toEqual({ cursor: "c1", limit: "10" });
    expect(stub.calls[1]!.body).toEqual({ thread_name: "alt" });
    expect(stub.calls[3]!.query).toEqual({ name: "r", version: "2" });
  });

  it("syncs agent definitions and runs the agent doctor", async () => {
    const { client, stub } = await setup((c, res) =>
      json(res, c.path.endsWith("/doctor") ? { ok: true, checks: [] } : { agent: { id: "a1" } }),
    );
    await client.createManagedAgent({ name: "x" });
    await client.updateAgentDefinition("a1", { name: "x" });
    expect(await client.agentDoctor("a1")).toMatchObject({ ok: true });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /exo/agent/managed",
      "PUT /exo/agent/a1/definition",
      "GET /exo/agent/a1/doctor",
    ]);
  });

  it("percent-encodes path segments", async () => {
    const { client, stub } = await setup((_c, res) => json(res, { active: false }));
    await client.getTurn("a b", "t/1", "u?");
    expect(stub.calls[0]!.path).toBe("/exo/agent/a%20b/thread/t%2F1/turn/u%3F");
  });

  it("sends a bearer token only when configured (V-1 is unverified)", async () => {
    const without = await setup((_c, res) => json(res, { agents: [] }));
    await without.client.listAgents();
    expect(without.stub.calls[0]!.headers.authorization).toBeUndefined();
    const withToken = await setup((_c, res) => json(res, { agents: [] }), { bearerToken: "tok" });
    await withToken.client.listAgents();
    expect(withToken.stub.calls[0]!.headers.authorization).toBe("Bearer tok");
  });
});

describe("failure handling (BUILD.md §4.9)", () => {
  const unavailable = (res: ServerResponse, status = 503) => json(res, { error: "down" }, status);

  it("retries reads on 502/503/504 with jittered exponential backoff, then succeeds", async () => {
    const { client, stub, sleeps } = await setup((_c, res, n) =>
      n < 3 ? unavailable(res, n === 1 ? 503 : 502) : json(res, { agents: [{ id: "a" }] }),
    );
    expect(await client.listAgents()).toEqual([{ id: "a" }]);
    expect(stub.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    // random() = 0.5 gives factor 1.0: base 200 ms, then 400 ms.
    expect(sleeps).toEqual([200, 400]);
  });

  it("gives up after three retries with ExoUnavailableError", async () => {
    const { client, stub } = await setup((_c, res) => unavailable(res, 504));
    await expect(client.listAgents()).rejects.toBeInstanceOf(ExoUnavailableError);
    expect(stub.calls).toHaveLength(4);
  });

  it("jitter stays within +/-50% of the base delay", async () => {
    const lo = await setup((_c, res) => unavailable(res), { random: () => 0 });
    await expect(lo.client.listAgents()).rejects.toBeInstanceOf(ExoUnavailableError);
    expect(lo.sleeps).toEqual([100, 200, 400]);
    const hi = await setup((_c, res) => unavailable(res), { random: () => 0.999999 });
    await expect(hi.client.listAgents()).rejects.toBeInstanceOf(ExoUnavailableError);
    expect(hi.sleeps.every((ms, i) => ms <= 300 * 2 ** i)).toBe(true);
  });

  it("maps a refused connection to ExoUnavailableError", async () => {
    const stub = await startStub((_c, res) => json(res, {}));
    const baseUrl = stub.baseUrl;
    await stub.close();
    const client = new ExoClient({ baseUrl, sleep: async () => {}, random: () => 0.5 });
    const err = await client.listAgents().catch((e) => e);
    expect(err).toBeInstanceOf(ExoUnavailableError);
    expect((err as ExoUnavailableError).code).toBe("exo_unavailable");
    expect((err as ExoUnavailableError).attempts).toBe(4);
  });

  it("never retries a turn submission without an idempotency guarantee", async () => {
    const { client, stub } = await setup((_c, res) => unavailable(res));
    await expect(client.submitTurn("a", "t", { input: "x" })).rejects.toBeInstanceOf(
      ExoUnavailableError,
    );
    expect(stub.calls).toHaveLength(1);
  });

  it("retries a write when the caller vouches for idempotency (stored key)", async () => {
    const { client, stub } = await setup((_c, res, n) =>
      n < 2
        ? unavailable(res)
        : json(res, { agent: {}, thread: {}, turn: { id: "u" }, harness: "h" }),
    );
    const out = await client.submitTurn("a", "t", { input: "x" }, { idempotent: true });
    expect(ExoClient.turnId(out)).toBe("u");
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry 4xx or 500; surfaces ExoHttpError with status and body", async () => {
    const { client, stub } = await setup((_c, res, n) =>
      json(res, { error: n === 1 ? "bad" : "boom" }, n === 1 ? 404 : 500),
    );
    const notFound = await client.getTurn("a", "t", "u").catch((e) => e);
    expect(notFound).toBeInstanceOf(ExoHttpError);
    expect(notFound).toMatchObject({ status: 404, body: { error: "bad" } });
    const boom = await client.getTurn("a", "t", "u").catch((e) => e);
    expect(boom).toMatchObject({ status: 500 });
    expect(stub.calls).toHaveLength(2);
  });

  it("times out a hung request and reports it as unavailable", async () => {
    const { client, stub } = await setup(() => new Promise<void>(() => {}), {
      requestTimeoutMs: 80,
      retries: 1,
    });
    const err = await client.getTurn("a", "t", "u").catch((e) => e);
    expect(err).toBeInstanceOf(ExoUnavailableError);
    expect(err.message).toMatch(/timed out|timeout|aborted/i);
    expect(stub.calls).toHaveLength(2);
  });

  it("rejects a non-JSON or wrongly shaped body with ExoProtocolError", async () => {
    const a = await setup((_c, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("<html>nope</html>");
    });
    await expect(a.client.listAgents()).rejects.toBeInstanceOf(ExoProtocolError);
    const b = await setup((_c, res) => json(res, { agents: "not-an-array" }));
    await expect(b.client.listAgents()).rejects.toBeInstanceOf(ExoProtocolError);
    const c = await setup((_c, res) => json(res, { events: [{ type: "no_id" }] }));
    await expect(c.client.listEvents("a", "t")).rejects.toBeInstanceOf(ExoProtocolError);
  });
});

function sse(res: ServerResponse, frames: string[], { end = true } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const f of frames) res.write(f);
  if (end) res.end();
}

describe("watchEvents (SSE)", () => {
  const frame = (id: string, type: string, extra: object = {}) =>
    `id: ${id}\ndata: ${JSON.stringify({ id, type, ...extra })}\n\n`;

  it("streams events, ignores comments, and joins multi-line data", async () => {
    const { client } = await setup((_c, res) =>
      sse(res, [
        ": keep-alive\n\n",
        frame("e1", "turn_started"),
        `data: {"id":"e2",\ndata: "type":"messages"}\n\n`,
        frame("e3", "turn_ended"),
      ]),
    );
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", { reconnect: false }))
      got.push(`${e.id}:${e.type}`);
    expect(got).toEqual(["e1:turn_started", "e2:messages", "e3:turn_ended"]);
  });

  it("reconnects with after=<last id> and never delivers an event twice", async () => {
    const { client, stub } = await setup((c, res, n) => {
      if (n === 1) return sse(res, [frame("e1", "turn_started"), frame("e2", "messages")]);
      // After the drop the server replays e2 (at-least-once) and continues.
      expect(c.query.after).toBe("e2");
      sse(res, [frame("e2", "messages"), frame("e3", "turn_ended")]);
    });
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", {
      stopWhen: (ev) => ev.type === "turn_ended",
    }))
      got.push(e.id);
    expect(got).toEqual(["e1", "e2", "e3"]);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]!.query.after).toBeUndefined();
  });

  it("starts from a given cursor", async () => {
    const { client, stub } = await setup((_c, res) => sse(res, [frame("e8", "messages")]));
    for await (const _ of client.watchEvents("a", "t", { after: "e7", reconnect: false })) void _;
    expect(stub.calls[0]!.query.after).toBe("e7");
    expect(stub.calls[0]!.headers.accept).toContain("text/event-stream");
  });

  it("stops when the abort signal fires", async () => {
    const ctl = new AbortController();
    const { client } = await setup((_c, res) =>
      sse(res, [frame("e1", "turn_started")], { end: false }),
    );
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", { signal: ctl.signal })) {
      got.push(e.id);
      ctl.abort();
    }
    expect(got).toEqual(["e1"]);
  });

  it("gives up with ExoUnavailableError when reconnecting keeps failing", async () => {
    const { client } = await setup((_c, res, n) =>
      n === 1 ? sse(res, [frame("e1", "x")]) : json(res, {}, 503),
    );
    const run = async () => {
      for await (const _ of client.watchEvents("a", "t")) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(ExoUnavailableError);
  });
});

describe("watchEvents edge cases", () => {
  it("handles CRLF line endings, an event: field and a final frame without a blank line", async () => {
    const { client } = await setup((_c, res) =>
      sse(res, [
        'id: e1\r\nevent: message\r\ndata: {"id":"e1","type":"a"}\r\n\r\n',
        'data: {"id":"e2","type":"b"}', // connection closes before the terminating blank line
      ]),
    );
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", { reconnect: false })) got.push(e.id);
    expect(got).toEqual(["e1", "e2"]);
  });

  it("takes the event id from the SSE id: line when the JSON has none", async () => {
    const { client } = await setup((_c, res) =>
      sse(res, ['id: e5\ndata: {"type":"messages"}\n\n']),
    );
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", { reconnect: false })) got.push(e.id);
    expect(got).toEqual(["e5"]);
  });

  it("raises ExoProtocolError for data that is not JSON", async () => {
    const { client } = await setup((_c, res) => sse(res, ["data: not json\n\n"]));
    const run = async () => {
      for await (const _ of client.watchEvents("a", "t", { reconnect: false })) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(ExoProtocolError);
  });

  it("does not retry a 404 on the stream; it surfaces ExoHttpError", async () => {
    const { client, stub } = await setup((_c, res) => json(res, { error: "no thread" }, 404));
    const run = async () => {
      for await (const _ of client.watchEvents("a", "t")) void _;
    };
    await expect(run()).rejects.toMatchObject({ status: 404 });
    expect(stub.calls).toHaveLength(1);
  });

  it("treats a stream that keeps closing without events as unavailable", async () => {
    const { client, stub } = await setup((_c, res) => sse(res, []));
    const run = async () => {
      for await (const _ of client.watchEvents("a", "t")) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(ExoUnavailableError);
    expect(stub.calls).toHaveLength(4);
  });

  it("recovers from a connection dropped in the middle of the stream", async () => {
    const { client, stub } = await setup((_c, res, n) => {
      if (n === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('id: e1\ndata: {"id":"e1","type":"a"}\n\n');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      sse(res, ['id: e2\ndata: {"id":"e2","type":"turn_ended"}\n\n']);
    });
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", {
      stopWhen: (ev) => ev.type === "turn_ended",
    })) {
      got.push(e.id);
    }
    expect(got).toEqual(["e1", "e2"]);
    expect(stub.calls[1]!.query.after).toBe("e1");
  });

  it("keeps following a stream that drops again and again as long as each connection made progress", async () => {
    const { client } = await setup((_c, res, n) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const type = n === 6 ? "turn_ended" : "a";
      res.write(`id: e${n}\ndata: {"id":"e${n}","type":"${type}"}\n\n`);
      if (n < 6) setTimeout(() => res.destroy(), 10);
      else res.end();
    });
    const got: string[] = [];
    for await (const e of client.watchEvents("a", "t", {
      stopWhen: (ev) => ev.type === "turn_ended",
    })) {
      got.push(e.id);
    }
    expect(got).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
  });
});

describe("events and usage", () => {
  it("parses an event and keeps unknown fields", () => {
    expect(parseEvent({ id: 7, type: "tool_requested", tool: "x" })).toEqual({
      id: "7",
      type: "tool_requested",
      tool: "x",
    });
  });

  it("rejects an event without id or type", () => {
    expect(() => parseEvent({ type: "x" })).toThrow(ExoProtocolError);
    expect(() => parseEvent({ id: "1" })).toThrow(ExoProtocolError);
    expect(() => parseEvent("nope")).toThrow(ExoProtocolError);
  });

  it("extracts usage from a messages event", () => {
    const e = parseEvent({
      id: "e1",
      type: "messages",
      usage: {
        model: "claude-opus-5-5",
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_cached_tokens: 5,
        prompt_cache_creation_tokens: 7,
        completion_reasoning_tokens: 3,
        cost_usd: 0.0123,
        ttft_ms: 250,
        duration_ms: 4000,
      },
    });
    expect(usageOf(e)).toEqual({
      model: "claude-opus-5-5",
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_cached_tokens: 5,
      prompt_cache_creation_tokens: 7,
      completion_reasoning_tokens: 3,
      cost_usd: 0.0123,
      ttft_ms: 250,
      duration_ms: 4000,
    });
  });

  it("defaults missing token counts to 0 and leaves an absent cost undefined", () => {
    const u = usageOf(parseEvent({ id: "e", type: "messages", usage: { model: "m" } }));
    expect(u).toMatchObject({ model: "m", prompt_tokens: 0, completion_tokens: 0 });
    expect(u!.cost_usd).toBeUndefined();
  });

  it("returns null for events without usage and for other types", () => {
    expect(usageOf(parseEvent({ id: "e", type: "messages" }))).toBeNull();
    expect(usageOf(parseEvent({ id: "e", type: "turn_ended", usage: { model: "m" } }))).toBeNull();
  });
});
