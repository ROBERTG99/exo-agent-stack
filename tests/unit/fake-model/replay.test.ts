/* eslint-disable @typescript-eslint/no-explicit-any -- model API responses are schemaless JSON in these assertions */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFakeModel, loadScenarios } from "@exos/fake-model/server";

const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function app(opts: Parameters<typeof buildFakeModel>[0] = {}) {
  const a = await buildFakeModel(opts);
  apps.push(a);
  return a;
}

// --- request builders for the three wire formats -----------------------------------------------

const responsesReq = (scenario: string | null, toolResults = 0, stream = false) => ({
  model: "fake-model",
  stream,
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: `go ${scenario ? `[[scenario:${scenario}]]` : ""}` }],
    },
    ...Array.from({ length: toolResults }, (_, i) => [
      { type: "function_call", call_id: `call_${scenario}_${i}`, name: "t", arguments: "{}" },
      { type: "function_call_output", call_id: `call_${scenario}_${i}`, output: "ok" },
    ]).flat(),
  ],
});

const chatReq = (scenario: string | null, toolResults = 0, stream = false) => ({
  model: "fake-model",
  stream,
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: `go ${scenario ? `[[scenario:${scenario}]]` : ""}` },
    ...Array.from({ length: toolResults }, (_, i) => [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${scenario}_${i}`,
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: `call_${scenario}_${i}`, content: "ok" },
    ]).flat(),
  ],
});

const messagesReq = (scenario: string | null, toolResults = 0, stream = false) => ({
  model: "claude-fake",
  max_tokens: 1024,
  stream,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: `go ${scenario ? `[[scenario:${scenario}]]` : ""}` }],
    },
    ...Array.from({ length: toolResults }, (_, i) => [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: `call_${scenario}_${i}`, name: "t", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `call_${scenario}_${i}`, content: "ok" }],
      },
    ]).flat(),
  ],
});

// --- what the next step looks like in each format ----------------------------------------------

type Step = { tool: string; args: unknown; id: string } | { text: string };

function readResponses(body: any): Step {
  const call = body.output.find((o: any) => o.type === "function_call");
  if (call) return { tool: call.name, args: JSON.parse(call.arguments), id: call.call_id };
  return { text: body.output[0].content[0].text };
}
function readChat(body: any): Step {
  const msg = body.choices[0].message;
  if (msg.tool_calls?.length) {
    const c = msg.tool_calls[0];
    return { tool: c.function.name, args: JSON.parse(c.function.arguments), id: c.id };
  }
  return { text: msg.content };
}
function readMessages(body: any): Step {
  const use = body.content.find((b: any) => b.type === "tool_use");
  if (use) return { tool: use.name, args: use.input, id: use.id };
  return { text: body.content[0].text };
}

const formats = [
  { name: "responses", url: "/v1/responses", req: responsesReq, read: readResponses },
  { name: "chat.completions", url: "/v1/chat/completions", req: chatReq, read: readChat },
  { name: "messages", url: "/v1/messages", req: messagesReq, read: readMessages },
] as const;

async function step(
  a: Awaited<ReturnType<typeof app>>,
  f: (typeof formats)[number],
  scenario: string | null,
  n = 0,
) {
  const res = await a.inject({ method: "POST", url: f.url, payload: f.req(scenario, n) });
  return { res, body: res.json() as any };
}

describe.each(formats)("$name: scenario replay", (f) => {
  it("answers a plain scenario with text", async () => {
    const a = await app();
    const { res, body } = await step(a, f, "plain");
    expect(res.statusCode).toBe(200);
    expect("text" in f.read(body)).toBe(true);
  });

  it("falls back to the plain scenario without a marker", async () => {
    const a = await app();
    const { body } = await step(a, f, null);
    expect("text" in f.read(body)).toBe(true);
  });

  it("follows steps12 one tool call at a time, with deterministic call ids", async () => {
    const a = await app();
    for (let i = 0; i < 12; i++) {
      const { body } = await step(a, f, "steps12", i);
      expect(f.read(body)).toEqual({
        tool: "ledger_append",
        args: { seq: i + 1 },
        id: `call_steps12_${i}`,
      });
    }
    const { body } = await step(a, f, "steps12", 12);
    expect("text" in f.read(body)).toBe(true);
  });

  it("is stateless: the same history always yields the same next step (replay after a crash)", async () => {
    const a = await app();
    const first = f.read((await step(a, f, "steps12", 6)).body);
    const again = f.read((await step(a, f, "steps12", 6)).body);
    const other = await app();
    const fresh = f.read((await step(other, f, "steps12", 6)).body);
    expect(again).toEqual(first);
    expect(fresh).toEqual(first);
    expect(first).toMatchObject({ tool: "ledger_append", args: { seq: 7 } });
  });

  it("serves identical answers to parallel identical requests", async () => {
    const a = await app();
    const all = await Promise.all(Array.from({ length: 10 }, () => step(a, f, "steps12", 3)));
    const reads = all.map((r) => JSON.stringify(f.read(r.body)));
    expect(new Set(reads).size).toBe(1);
  });

  it("rejects an unknown scenario with a 400 error body", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: f.url, payload: f.req("no-such-scenario") });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/unknown_scenario/);
  });

  it("rejects a malformed body with a 400", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: f.url, payload: { nonsense: true } });
    expect(res.statusCode).toBe(400);
  });
});

describe("scenario library", () => {
  it("ships the scenarios the suites refer to", async () => {
    const a = await app();
    for (const id of [
      "plain",
      "slow",
      "approval-edit",
      "approval-git-push",
      "ask-user",
      "report-twice",
    ]) {
      const { res } = await step(a, formats[0], id);
      expect(res.statusCode, id).toBe(200);
    }
  });

  it("generates stepsN scenarios for 1..200 and refuses anything else", async () => {
    const a = await app();
    expect((await step(a, formats[0], "steps8")).res.statusCode).toBe(200);
    expect((await step(a, formats[0], "steps200")).res.statusCode).toBe(200);
    expect((await step(a, formats[0], "steps0")).res.statusCode).toBe(400);
    expect((await step(a, formats[0], "steps201")).res.statusCode).toBe(400);
    expect((await step(a, formats[0], "steps12x")).res.statusCode).toBe(400);
  });

  it("approval scenarios ask the harness to authorise the documented tools", async () => {
    const a = await app();
    expect(formats[0].read((await step(a, formats[0], "approval-git-push")).body)).toMatchObject({
      tool: "authorize",
      args: { name: "claude.Bash", arguments: { command: expect.stringContaining("git push") } },
    });
    expect(formats[0].read((await step(a, formats[0], "approval-edit")).body)).toMatchObject({
      tool: "authorize",
      args: { name: "claude.Edit" },
    });
    expect(formats[0].read((await step(a, formats[0], "ask-user")).body)).toMatchObject({
      tool: "ask_user",
    });
  });

  it("report-twice writes the same report name twice (two artifact versions, FR-7)", async () => {
    const a = await app();
    const first = formats[0].read((await step(a, formats[0], "report-twice", 0)).body) as any;
    const second = formats[0].read((await step(a, formats[0], "report-twice", 1)).body) as any;
    expect([first.tool, second.tool]).toEqual(["write_report", "write_report"]);
    expect(first.args.name).toBe(second.args.name);
    expect(first.args.content).not.toBe(second.args.content);
  });
});

describe("usage reporting", () => {
  it("reports scenario token usage in each format", async () => {
    const a = await app();
    const r = (await step(a, formats[0], "plain")).body.usage;
    const c = (await step(a, formats[1], "plain")).body.usage;
    const m = (await step(a, formats[2], "plain")).body.usage;
    expect(r).toMatchObject({ input_tokens: 100, output_tokens: 20, total_tokens: 120 });
    expect(c).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    expect(m).toMatchObject({ input_tokens: 100, output_tokens: 20 });
  });
});

describe("streaming", () => {
  it("streams the Responses API ending in response.completed", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/responses",
      payload: responsesReq("steps12", 2, true),
    });
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.body).toContain("event: response.output_item.done");
    expect(res.body).toContain("event: response.completed");
    expect(res.body).toContain("call_steps12_2");
  });

  it("streams chat completions ending in [DONE]", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatReq("plain", 0, true),
    });
    expect(res.body.trim().endsWith("data: [DONE]")).toBe(true);
    expect(res.body).toContain("chat.completion.chunk");
  });

  it("streams messages ending in message_stop", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesReq("plain", 0, true),
    });
    expect(res.body).toContain("event: message_start");
    expect(res.body).toContain("event: message_stop");
  });
});

describe("fault injection (FAKE_MODEL_FAULTS)", () => {
  it("injects a 429 with retry-after on every Nth request", async () => {
    const a = await app({ faults: { rate_limit_every: 2 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await step(a, formats[0], "plain")).res.statusCode);
    expect(codes).toEqual([200, 429, 200, 429]);
    const limited = await step(a, formats[0], "plain");
    expect(limited.res.statusCode).toBe(200);
    const again = await step(a, formats[0], "plain");
    expect(again.res.headers["retry-after"]).toBe("1");
  });

  it("injects a 500 on every Nth request", async () => {
    const a = await app({ faults: { error_every: 3 } });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await step(a, formats[1], "plain")).res.statusCode);
    expect(codes).toEqual([200, 200, 500, 200, 200, 500]);
  });

  it("adds latency through the injected sleep", async () => {
    const slept: number[] = [];
    const a = await app({ faults: { latency_ms: 250 }, sleep: async (ms) => void slept.push(ms) });
    await step(a, formats[2], "plain");
    expect(slept).toEqual([250]);
  });

  it("a request header forces a one-off fault", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { "x-fake-fault": "500" },
      payload: responsesReq("plain"),
    });
    expect(res.statusCode).toBe(500);
  });

  it("the slow scenario delays each step", async () => {
    const slept: number[] = [];
    const a = await app({ sleep: async (ms) => void slept.push(ms) });
    await step(a, formats[0], "slow");
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
  });

  it("does not count health checks or model listings as requests", async () => {
    const a = await app({ faults: { error_every: 1 } });
    expect((await a.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(200);
  });
});

describe("request recording for Mode B (FR-5)", () => {
  it("records the Authorization and x-api-key headers of /v1/messages", async () => {
    const a = await app();
    await a.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: "Bearer exo_egress_test", "anthropic-version": "2023-06-01" },
      payload: messagesReq("plain"),
    });
    const log = (
      await a.inject({ method: "GET", url: "/__test/requests?path=/v1/messages" })
    ).json() as any;
    expect(log.requests).toHaveLength(1);
    expect(log.requests[0].headers.authorization).toBe("Bearer exo_egress_test");
    expect(log.requests[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("resets the log and never stores request bodies", async () => {
    const a = await app();
    await a.inject({ method: "POST", url: "/v1/messages", payload: messagesReq("plain") });
    const log = (await a.inject({ method: "GET", url: "/__test/requests" })).json() as any;
    expect(JSON.stringify(log)).not.toContain("go [[scenario");
    await a.inject({ method: "POST", url: "/__test/reset" });
    expect(
      ((await a.inject({ method: "GET", url: "/__test/requests" })).json() as any).requests,
    ).toHaveLength(0);
  });
});

describe("scenario files", () => {
  const dirWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "scenarios-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  it("loads valid scenarios", () => {
    const s = loadScenarios(
      dirWith({ "ok.yaml": "id: ok\nsteps:\n  - tool: t\n    args: {a: 1}\n  - text: done\n" }),
    );
    expect(s.get("ok")!.steps).toHaveLength(2);
  });

  it.each([
    ["an unknown key", "id: x\nsteps:\n  - text: hi\nbogus: 1\n"],
    ["no steps", "id: x\nsteps: []\n"],
    ["a step with both tool and text", "id: x\nsteps:\n  - tool: t\n    text: hi\n"],
    ["a duplicate id", "id: plain\nsteps:\n  - text: hi\n"],
    ["an invalid id", "id: Bad Id\nsteps:\n  - text: hi\n"],
  ])("rejects %s, naming the file", (_n, yaml) => {
    const dir = dirWith({ "a.yaml": "id: plain\nsteps:\n  - text: first\n", "bad.yaml": yaml });
    expect(() => loadScenarios(dir)).toThrow(/bad\.yaml|a\.yaml/);
  });

  it("lists models", async () => {
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/v1/models" })).json() as any;
    expect(body.data.map((m: any) => m.id)).toEqual(expect.arrayContaining(["fake-model"]));
  });
});
