/* eslint-disable @typescript-eslint/no-explicit-any -- event and frame payloads are schemaless in this suite */
// T-24: events, the SSE relay, artifacts and lineage (BUILD.md §4.6, FR-14).
import { afterEach, describe, expect, it } from "vitest";
import { startStack, until, type Stack } from "../helpers/stack.ts";

const stacks: Stack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});
async function stack(opts: Parameters<typeof startStack>[0] = {}) {
  const s = await startStack(opts);
  stacks.push(s);
  return s;
}

let n = 0;
const nextKey = () => `key-sse-${String(++n).padStart(6, "0")}`;

async function startThread(s: Stack, prompt: string, agent = "repo-builder") {
  const r = await s.call("POST", "/api/v1/threads", { agent, prompt, idempotency_key: nextKey() });
  expect(r.status).toBe(201);
  return r.body as { thread_slug: string; thread_id: string; turn_id: string; agent_id: string };
}
const idle = (s: Stack, slug: string) =>
  until(
    async () => (await s.call("GET", `/api/v1/threads/repo-builder/${slug}`)).body.state === "idle",
    "idle",
  );

interface Frame {
  id?: string;
  event?: string;
  data?: any;
  comment?: string;
}

/** Reads SSE frames until `stop` says so (or the stream ends), then closes the connection. */
async function readSse(
  s: Stack,
  path: string,
  opts: {
    headers?: Record<string, string>;
    stop?: (f: Frame, all: Frame[]) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ frames: Frame[]; status: number; contentType: string | null }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 10_000);
  const res = await fetch(`${s.url}${path}`, {
    headers: { authorization: `Bearer ${s.token}`, ...opts.headers },
    signal: abort.signal,
  });
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      outer: for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const frame: Frame = {};
          for (const line of raw.split("\n")) {
            if (line.startsWith(":")) frame.comment = line.slice(1).trim();
            else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
            else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:")) frame.data = JSON.parse(line.slice(5).trim());
          }
          if (frame.comment !== undefined && frame.id === undefined && frame.data === undefined)
            continue;
          frames.push(frame);
          if (opts.stop?.(frame, frames)) break outer;
        }
      }
    } else {
      await res.text();
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return { frames, status: res.status, contentType: res.headers.get("content-type") };
}

const eventsPath = (slug: string, q = "") => `/api/v1/threads/repo-builder/${slug}/events${q}`;
const streamPath = (slug: string, q = "") => `/api/v1/threads/repo-builder/${slug}/stream${q}`;

describe("GET /threads/{agent}/{thread}/events", () => {
  it("lists events as views: stack-written summaries, agent text only in untrusted_text", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:plain]] hello");
    await idle(s, t.thread_slug);
    const r = await s.call("GET", eventsPath(t.thread_slug, "?limit=200"));
    expect(r.status).toBe(200);
    expect(r.body.turn_active).toBe(false);
    const types = r.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["thread_created", "turn_started", "messages", "turn_ended"]),
    );
    for (const e of r.body.events) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.summary).toBe("string");
      expect(e.summary).not.toContain("Plain scenario answer");
      expect(e.summary).not.toContain("hello");
    }
    const assistant = r.body.events.find(
      (e: any) => e.type === "messages" && e.untrusted_text === "Plain scenario answer.",
    );
    expect(assistant).toBeTruthy();
    expect(r.body.next_after).toBe(r.body.events.at(-1).id);
  });

  it("pages with after and limit and filters by one or several types", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:steps12]] go");
    await idle(s, t.thread_slug);
    const all = (await s.call("GET", eventsPath(t.thread_slug, "?limit=200"))).body.events;
    const first = (await s.call("GET", eventsPath(t.thread_slug, "?limit=5"))).body;
    expect(first.events).toHaveLength(5);
    const second = (
      await s.call("GET", eventsPath(t.thread_slug, `?limit=5&after=${first.next_after}`))
    ).body;
    expect(second.events.map((e: any) => e.id)).toEqual(all.slice(5, 10).map((e: any) => e.id));
    const one = (await s.call("GET", eventsPath(t.thread_slug, "?types=tool_result&limit=200")))
      .body;
    expect(one.events).toHaveLength(12);
    const two = (
      await s.call("GET", eventsPath(t.thread_slug, "?types=tool_requested,turn_ended&limit=200"))
    ).body;
    expect(new Set(two.events.map((e: any) => e.type))).toEqual(
      new Set(["tool_requested", "turn_ended"]),
    );
    expect(two.events).toHaveLength(13);
    const empty = (await s.call("GET", eventsPath(t.thread_slug, `?after=${all.at(-1).id}`))).body;
    expect(empty).toMatchObject({ events: [], next_after: all.at(-1).id });
  });

  it("rejects a bad limit or after with 400 and an unknown thread with 404", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:plain]] hello");
    for (const q of [
      "?limit=0",
      "?limit=201",
      "?limit=abc",
      "?after=has%20space",
      "?types=Bad%20Type",
    ]) {
      const r = await s.call("GET", eventsPath(t.thread_slug, q));
      expect(r.status, q).toBe(400);
      expect(r.body.code).toBe("invalid_input");
    }
    expect((await s.call("GET", eventsPath("nope"))).status).toBe(404);
  });

  it("renders an event type it does not know generically", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:plain]] hello");
    await idle(s, t.thread_slug);
    s.sim.store.addEvent(t.thread_id, { type: "brand_new_event", payload: { detail: "x" } });
    const { events } = (await s.call("GET", eventsPath(t.thread_slug, "?types=brand_new_event")))
      .body;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "brand_new_event",
      summary: "event of type brand_new_event",
    });
  });

  it("names tools, approvals and artifacts in summaries without including their content", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:report-twice]] write");
    await idle(s, t.thread_slug);
    const evs = (await s.call("GET", eventsPath(t.thread_slug, "?limit=200"))).body.events;
    const written = evs.filter((e: any) => e.type === "artifact_written");
    expect(written.map((e: any) => e.summary)).toEqual([
      "artifact summary written (version 1)",
      "artifact summary written (version 2)",
    ]);
    const requested = evs.find((e: any) => e.type === "tool_requested");
    expect(requested).toMatchObject({
      tool: "write_report",
      summary: "tool requested: write_report",
    });
  });
});

describe("GET /threads/{agent}/{thread}/stream", () => {
  it("relays every event once, in order, as SSE with ids", async () => {
    const s = await stack({ stepDelayMs: 30 });
    const t = await startThread(s, "[[scenario:steps12]] go");
    const { frames, status, contentType } = await readSse(s, streamPath(t.thread_slug), {
      stop: (f) => f.data?.type === "turn_ended",
    });
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    const ids = frames.filter((f) => f.id).map((f) => f.id!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.map(Number)).toEqual([...ids.map(Number)].sort((a, b) => a - b));
    const listed = (await s.call("GET", eventsPath(t.thread_slug, "?limit=200"))).body.events;
    expect(ids).toEqual(listed.map((e: any) => e.id));
    expect(frames[0]!.data).toMatchObject({ summary: expect.any(String) });
  });

  it("resumes after Last-Event-ID or ?after= without repeats or gaps", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:steps12]] go");
    await idle(s, t.thread_slug);
    const listed = (await s.call("GET", eventsPath(t.thread_slug, "?limit=200"))).body.events.map(
      (e: any) => e.id,
    );
    const resume = listed[2];
    const viaHeader = await readSse(s, streamPath(t.thread_slug), {
      headers: { "last-event-id": resume },
      stop: (f) => f.data?.type === "turn_ended",
    });
    expect(viaHeader.frames.map((f) => f.id)).toEqual(listed.slice(3));
    const viaQuery = await readSse(s, streamPath(t.thread_slug, `?after=${resume}`), {
      stop: (f) => f.data?.type === "turn_ended",
    });
    expect(viaQuery.frames.map((f) => f.id)).toEqual(listed.slice(3));
  });

  it("delivers events written after the stream opened within a second (p95)", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:plain]] hello");
    await idle(s, t.thread_slug);
    const sentAt = new Map<string, number>();
    const latencies: number[] = [];
    const lastId = (await s.call("GET", eventsPath(t.thread_slug, "?limit=200"))).body.next_after;
    const reader = readSse(s, streamPath(t.thread_slug, `?after=${lastId}`), {
      stop: (f) => {
        const at = sentAt.get(String(f.data?.data?.marker));
        if (at !== undefined) latencies.push(Date.now() - at);
        return latencies.length >= 20;
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    for (let i = 0; i < 20; i++) {
      sentAt.set(`m${i}`, Date.now());
      const e = s.sim.store.addEvent(t.thread_id, {
        type: "marker_event",
        payload: { marker: `m${i}` },
      });
      expect(e.id).toBeTruthy();
      await new Promise((r) => setTimeout(r, 25));
    }
    await reader;
    expect(latencies).toHaveLength(20);
    const p95 = [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(1000);
  });

  it("answers 404 and 401 as problem+json before any stream starts", async () => {
    const s = await stack();
    const missing = await readSse(s, streamPath("nope"));
    expect(missing.status).toBe(404);
    expect(missing.contentType).toContain("application/problem+json");
    const res = await fetch(`${s.url}${streamPath("nope")}`);
    expect(res.status).toBe(401);
  });

  it("tells the client when Exo is down, with a code it can show, then ends the stream", async () => {
    const s = await stack({ stepDelayMs: 40 });
    const t = await startThread(s, "[[scenario:steps12]] go");
    const result = readSse(s, streamPath(t.thread_slug), { timeoutMs: 15_000 });
    await until(() => s.sim.store.allEvents(t.thread_id).length > 6, "a few events");
    await s.stopExo();
    const { frames } = await result;
    const last = frames.at(-1)!;
    expect(last.event).toBe("stream_error");
    expect(last.data).toMatchObject({ code: "exo_unavailable" });
  });
});

describe("artifacts and lineage", () => {
  it("lists artifacts and reads a version, flagging the content as untrusted", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:report-twice]] write");
    await idle(s, t.thread_slug);
    const list = await s.call("GET", `/api/v1/threads/repo-builder/${t.thread_slug}/artifacts`);
    expect(list.status).toBe(200);
    expect(
      list.body.artifacts.map((a: { name: string; version: number }) => `${a.name}@${a.version}`),
    ).toEqual(["summary@1", "summary@2"]);
    const latest = await s.call(
      "GET",
      `/api/v1/threads/repo-builder/${t.thread_slug}/artifacts/summary`,
    );
    expect(latest.body).toMatchObject({ name: "summary", version: 2, untrusted: true });
    expect(latest.body.untrusted_text).toContain("second draft");
    const v1 = await s.call(
      "GET",
      `/api/v1/threads/repo-builder/${t.thread_slug}/artifacts/summary?version=1`,
    );
    expect(v1.body.untrusted_text).toContain("first draft");
    expect(
      (await s.call("GET", `/api/v1/threads/repo-builder/${t.thread_slug}/artifacts/ghost`)).status,
    ).toBe(404);
  });

  it("shows where a fork came from and which threads came from a thread", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:plain]] hello");
    await idle(s, t.thread_slug);
    const fork = await s.call("POST", `/api/v1/threads/repo-builder/${t.thread_slug}:fork`, {
      idempotency_key: nextKey(),
    });
    const root = await s.call("GET", `/api/v1/threads/repo-builder/${t.thread_slug}/lineage`);
    expect(root.status).toBe(200);
    expect(root.body.parent).toBeNull();
    expect(root.body.children.map((c: { thread_slug: string }) => c.thread_slug)).toEqual([
      fork.body.thread_slug,
    ]);
    const child = await s.call(
      "GET",
      `/api/v1/threads/repo-builder/${fork.body.thread_slug}/lineage`,
    );
    expect(child.body.parent).toMatchObject({ thread_slug: t.thread_slug });
    expect(typeof child.body.parent.forked_at_event_id).toBe("string");
    expect(child.body.children).toEqual([]);
  });
});
