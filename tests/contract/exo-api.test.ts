// Contract tests for the Exo HTTP surface (BUILD.md §4.2). The committed recordings in
// fixtures/exo-recordings/exo-sim come from the offline simulator; a host re-recording of a real
// Exo must produce the same shapes (tests/contract/exo-real.test.ts, host-only). These tests check
// that the recordings, the WireMock mappings and the client agree with each other.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExoClient, ExoHttpError } from "../../packages/exo-client/src/index.ts";
import {
  compareDirs,
  diffShapes,
  normalise,
  readRecordings,
  readShapes,
  recordFromSim,
  shapeOf,
  toWiremockMapping,
  writeRecordings,
  writeWiremockMappings,
  type Recording,
} from "../../scripts/record-exo.ts";

const root = join(import.meta.dirname, "..", "..");
const recDir = join(root, "fixtures/exo-recordings/exo-sim");
const mappingsDir = join(root, "deploy/wiremock/mappings");
const recordings = readRecordings(recDir);
const byName = (n: string) => recordings.find((r) => r.name === n)!;

/** Answers client calls from the recordings: the n-th call to a URL gets its n-th recording. */
function replay(list: Recording[]) {
  const queues = new Map<string, Recording[]>();
  for (const r of list) {
    const key = `${r.request.method} ${r.request.path}?${r.request.query ?? ""}`;
    queues.set(key, [...(queues.get(key) ?? []), r]);
  }
  const bodies: Array<{ name: string; sent: unknown; recorded: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const query = [...u.searchParams.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("&");
    const sortedQuery = (q = "") => q.split("&").filter(Boolean).sort().join("&");
    const method = init?.method ?? "GET";
    const path = u.pathname.replace(/^\/exo/, "");
    const key = [...queues.keys()].find((k) => {
      const [m, rest] = [k.split(" ")[0], k.slice(k.indexOf(" ") + 1)];
      const [p, q] = rest.split("?");
      return m === method && p === path && sortedQuery(q) === query;
    });
    const next = key ? queues.get(key)!.shift() : undefined;
    if (!next) throw new Error(`no recording left for ${method} ${path}?${query}`);
    if (init?.body)
      bodies.push({
        name: next.name,
        sent: JSON.parse(String(init.body)),
        recorded: next.request.body,
      });
    if (next.response.sse_events) {
      const text = next.response.sse_events
        .map((e) => `id: ${(e as { id: string }).id}\ndata: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      next.response.body === undefined ? null : JSON.stringify(next.response.body),
      {
        status: next.response.status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

describe("recordings", () => {
  it("is a complete, parseable set with unique names and a shape for each", () => {
    expect(recordings.length).toBeGreaterThanOrEqual(30);
    const names = recordings.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(readShapes(recDir)).sort()).toEqual([...names].sort());
    for (const r of recordings) {
      expect(r.source).toBe("exo-sim");
      expect(r.request.method).toMatch(/^(GET|POST|PUT)$/);
    }
  });

  it("covers every endpoint of §4.2 and the error statuses the client maps", () => {
    const seen = new Set(
      recordings.map(
        (r) => `${r.request.method} ${r.request.path.replace(/\/(agt|thr|trn)_\d+/g, "/:id")}`,
      ),
    );
    for (const want of [
      "GET /agent",
      "GET /agent/:id/doctor",
      "GET /agent/:id/thread",
      "POST /agent/:id/thread",
      "POST /agent/:id/thread/:id/turn",
      "GET /agent/:id/thread/:id/turn/:id",
      "POST /agent/:id/thread/:id/turn/:id/cancel",
      "POST /agent/:id/thread/:id/turn/:id/approval-response",
      "POST /agent/:id/thread/:id/turn/:id/frontend-tool-result",
      "GET /agent/:id/thread/:id/event",
      "GET /agent/:id/thread/:id/event/watch",
      "POST /agent/:id/thread/:id/fork",
      "GET /agent/:id/thread/:id/artifact",
      "GET /agent/:id/thread/:id/artifact/read",
      "GET /agent/:id/thread/:id/previews",
    ]) {
      expect(seen, want).toContain(want);
    }
    const statuses = new Set(recordings.map((r) => r.response.status));
    for (const s of [200, 404, 409]) expect(statuses.has(s), String(s)).toBe(true);
  });

  it("holds nothing machine-specific, no timestamps and no secrets", () => {
    for (const f of readdirSync(recDir)) {
      const text = readFileSync(join(recDir, f), "utf8");
      expect(text, f).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders/);
      for (const m of text.matchAll(/"ts": "(\d{4}-[^"]*)"/g))
        expect(m[1], f).toBe("2026-01-01T00:00:00.000Z");
      expect(text, f).not.toMatch(/sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]{8,}/);
    }
  });
});

describe("the client against the recordings", () => {
  it("makes the recorded requests and parses the recorded responses", async () => {
    const { fetchImpl, bodies } = replay(recordings);
    const c = new ExoClient({ baseUrl: "http://exo.invalid/exo", fetch: fetchImpl, retries: 0 });
    const rec = (n: string) => byName(n);
    const agents = await c.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(7);
    const agent = (rec("agent-doctor").request.path.match(/agt_\d+/) ?? [])[0]!;
    expect((await c.listAgents({ slug: "repo-builder" }))[0]?.id).toBe(agent);
    expect(await c.agentDoctor(agent)).toMatchObject({ ok: true });
    await expect(c.listThreads("agent-that-does-not-exist")).rejects.toMatchObject({ status: 404 });

    const created = await c.createThread(agent, { vaults: [], thread_slug: "recording-a" });
    const a = String((created.thread as { id: string }).id);
    const again = await c.createThread(agent, { vaults: [], thread_slug: "recording-a" });
    expect((again.thread as { id: string }).id).toBe(a);
    expect((await c.listThreads(agent, { limit: 10 })).threads.length).toBeGreaterThanOrEqual(1);

    const t1 = (rec("turn-submit").response.body as { turn: { id: string; session_id: string } })
      .turn;
    const sub = await c.submitTurn(agent, a, {
      input: String((rec("turn-submit").request.body as { input: string }).input),
    });
    expect(ExoClient.turnId(sub)).toBe(t1.id);
    expect((await c.getTurn(agent, a, t1.id)).active).toBe(true);
    expect((await c.listEvents(agent, a, { limit: 1000 })).length).toBeGreaterThan(3);
    const approvalId = String(
      (rec("approval-respond").request.body as { approval_id: string }).approval_id,
    );
    const answer = {
      session_id: t1.session_id,
      approval_id: approvalId,
      approved: true,
      allow_for_tool: false,
    };
    await c.respondApproval(agent, a, t1.id, answer);
    expect((await c.getTurn(agent, a, t1.id)).active).toBe(false);
    expect((await c.listEvents(agent, a, { limit: 1000 })).at(-1)?.type).toBe("turn_ended");
    const last = await c.listEvents(agent, a, {
      direction: "desc",
      event_type: "turn_ended",
      limit: 1,
    });
    expect(last).toHaveLength(1);
    await expect(
      c.respondApproval(agent, a, t1.id, { ...answer, approved: false }),
    ).rejects.toMatchObject({ status: 409 });

    const streamed: string[] = [];
    for await (const e of c.watchEvents(agent, a, {
      after: "0",
      stopWhen: (x) => x.type === "turn_ended",
    }))
      streamed.push(e.type);
    expect(streamed.at(-1)).toBe("turn_ended");

    const r = String(
      (
        (await c.createThread(agent, { vaults: [], thread_slug: "recording-report" })).thread as {
          id: string;
        }
      ).id,
    );
    const t2 = ExoClient.turnId(
      await c.submitTurn(agent, r, { input: "[[scenario:report-twice]] write the summary" }),
    );
    expect(t2).toBeTruthy();
    expect((await c.listArtifacts(agent, r)).length).toBeGreaterThanOrEqual(1);
    expect(await c.readArtifact(agent, r, { name: "summary" })).toMatchObject({
      content: expect.stringContaining("second draft"),
    });
    expect(await c.readArtifact(agent, r, { name: "summary", version: 1 })).toMatchObject({
      content: expect.stringContaining("first draft"),
    });
    await expect(c.readArtifact(agent, r, { name: "ghost" })).rejects.toBeInstanceOf(ExoHttpError);
    expect(await c.getPreviews(agent, r)).toBeNull();
    const fork = await c.forkThread(agent, a, { thread_name: "recording-fork" });
    const forkId = String((fork.thread as { id: string }).id);
    expect((await c.listEvents(agent, forkId, { limit: 5 })).length).toBe(5);

    const b = String(
      (
        (await c.createThread(agent, { vaults: [], thread_slug: "recording-b" })).thread as {
          id: string;
        }
      ).id,
    );
    const t3 = ExoClient.turnId(
      await c.submitTurn(agent, b, {
        input: String((rec("turn-submit-busy").request.body as { input: string }).input),
      }),
    );
    await expect(c.submitTurn(agent, b, { input: "a second instruction" })).rejects.toMatchObject({
      status: 409,
    });
    expect((await c.cancelTurn(agent, b, t3)).canceled_active_turn).toBe(true);
    expect((await c.cancelTurn(agent, b, t3)).canceled_active_turn).toBeDefined();

    const cThread = String(
      (
        (await c.createThread(agent, { vaults: [], thread_slug: "recording-c" })).thread as {
          id: string;
        }
      ).id,
    );
    const t4 = (
      rec("turn-submit-frontend").response.body as { turn: { id: string; session_id: string } }
    ).turn;
    await c.submitTurn(agent, cThread, {
      input: String((rec("turn-submit-frontend").request.body as { input: string }).input),
      frontend_tools: [{ name: "ask_user" }],
    });
    const result = rec("frontend-tool-result").request.body as Parameters<
      ExoClient["sendFrontendToolResult"]
    >[3];
    await c.sendFrontendToolResult(agent, cThread, t4.id, result);
    await expect(c.sendFrontendToolResult(agent, cThread, t4.id, result)).rejects.toMatchObject({
      status: 409,
    });

    // every body the client sent is the recorded one, so a request-shape drift shows up here
    for (const b2 of bodies) expect(b2.sent, b2.name).toMatchObject(b2.recorded as object);
    expect(bodies.length).toBeGreaterThanOrEqual(10);
  });
});

describe("WireMock mappings", () => {
  it("are exactly what the recordings generate (no hand edits, no drift)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-mappings-"));
    try {
      const written = writeWiremockMappings(dir, recordings);
      const committed = readdirSync(mappingsDir)
        .filter((f) => /^exo-.*\.json$/.test(f))
        .sort();
      expect(committed).toEqual([...written].sort());
      for (const f of written) {
        expect(readFileSync(join(mappingsDir, f), "utf8"), f).toBe(
          readFileSync(join(dir, f), "utf8"),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serve the recorded body for the recorded request", () => {
    const m = toWiremockMapping(byName("agent-list-by-slug")) as {
      request: {
        method: string;
        urlPath: string;
        queryParameters: Record<string, { equalTo: string }>;
      };
      response: { status: number; body: string };
    };
    expect(m.request).toMatchObject({
      method: "GET",
      urlPath: "/exo/agent",
      queryParameters: { slug: { equalTo: "repo-builder" } },
    });
    expect(JSON.parse(m.response.body)).toEqual(byName("agent-list-by-slug").response.body);
    expect(existsSync(join(mappingsDir, "exo-agent-list.json"))).toBe(true);
  });
});

describe("shapes", () => {
  it("reduce a response to key names and value types", () => {
    expect(shapeOf({ b: [1, 2], a: { c: "x", d: null }, e: [] })).toEqual({
      a: { c: "string", d: "null" },
      b: ["number"],
      e: ["empty"],
    });
    expect(shapeOf([{ a: 1 }, { a: 2, b: true }])).toEqual([{ a: "number", b: "boolean" }]);
    expect(normalise({ ts: "2025-02-03T04:05:06.000Z", n: [{ ts: "x" }] })).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      n: [{ ts: "2026-01-01T00:00:00.000Z" }],
    });
  });

  it("fail on a lost key or a changed type and only note a new key", () => {
    const expected = shapeOf({ id: "a", n: 1, nested: { k: "v" }, list: [{ x: 1 }] });
    expect(
      diffShapes(expected, shapeOf({ id: "a", n: 1, nested: { k: "v" }, list: [{ x: 1 }] })),
    ).toEqual({ missing: [], changed: [], extra: [] });
    expect(
      diffShapes(expected, shapeOf({ id: "a", nested: { k: "v" }, list: [{ x: 1 }] })).missing,
    ).toEqual(["$.n"]);
    expect(
      diffShapes(expected, shapeOf({ id: 1, n: 1, nested: { k: "v" }, list: [{ x: 1 }] })).changed,
    ).toHaveLength(1);
    expect(
      diffShapes(expected, shapeOf({ id: "a", n: 1, nested: { k: "v", z: 1 }, list: [{ x: 1 }] }))
        .extra,
    ).toEqual(["$.nested.z"]);
    expect(
      diffShapes(expected, shapeOf({ id: "a", n: 1, nested: { k: "v" }, list: [{ y: 1 }] }))
        .missing,
    ).toEqual(["$.list[].x"]);
  });

  it("compare two recording directories by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-shapes-"));
    try {
      const copy = recordings.map((r) => structuredClone(r));
      writeRecordings(dir, copy);
      expect(compareDirs(recDir, dir).failures).toEqual([]);
      const broken = copy.map((r) =>
        r.name === "agent-list"
          ? { ...r, response: { status: 200, body: { agents: [{ id: "x" }] } } }
          : r,
      );
      writeRecordings(dir, broken);
      const { failures } = compareDirs(recDir, dir);
      expect(failures.some((f) => f.startsWith("agent-list: missing $.agents[].slug"))).toBe(true);
      writeFileSync(
        join(dir, "shapes.json"),
        JSON.stringify({ "agent-list": shapeOf({ agents: [] }) }),
      );
      expect(compareDirs(recDir, dir).failures).toContain("agent-doctor: not recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("re-recording", () => {
  it("against the simulator reproduces the committed recordings byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-rerecord-"));
    try {
      writeRecordings(dir, await recordFromSim(root));
      expect(compareDirs(recDir, dir)).toEqual({ failures: [], notes: [] });
      expect(readdirSync(dir)).toEqual(readdirSync(recDir));
      for (const f of readdirSync(recDir)) {
        expect(readFileSync(join(dir, f), "utf8"), f).toBe(readFileSync(join(recDir, f), "utf8"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
