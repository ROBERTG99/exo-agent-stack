/* eslint-disable @typescript-eslint/no-explicit-any -- chat messages and agent frontmatter are schemaless here */
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFakeModel } from "@exos/fake-model/server";
import {
  LocalModelError,
  chatCallModel,
  fromChatResponse,
  toChatMessages,
} from "../../harnesses/local-shim/chat-model.ts";
import {
  appendLedger,
  ledgerStats,
  runScriptedTurn,
  type InputItem,
  type ToolCall,
  type TurnPorts,
} from "../../harnesses/scripted/turn.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..", "..");
const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function startModel(faults = {}) {
  const app = await buildFakeModel({ faults, sleep: async () => {} });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1`;
}

function thread(prompt: string) {
  const items: InputItem[] = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
  const results = new Map<string, string>();
  const texts: string[] = [];
  return { items, results, texts };
}

function ports(
  t: ReturnType<typeof thread>,
  callModel: TurnPorts["callModel"],
  runTool: (c: ToolCall) => Promise<string>,
): TurnPorts {
  return {
    conversation: async () => t.items,
    callModel,
    existingResult: async (id) => t.results.get(id),
    recordToolCall: async (c) =>
      void t.items.push({
        type: "function_call",
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.args),
      }),
    runTool,
    recordResult: async (c, out) => {
      t.results.set(c.id, out);
      t.items.push({ type: "function_call_output", call_id: c.id, output: out });
    },
    emitText: async (x) => void t.texts.push(x),
    recordUsage: async () => {},
    maxRoundTrips: 64,
  };
}

describe("agents/local-harness.md", () => {
  const text = readFileSync(join(root, "agents", "local-harness.md"), "utf8");
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
  const def = parseYaml(front!) as any;

  it("points at a local OpenAI-compatible model on loopback, port 9842", () => {
    expect(def.name).toBe("local-harness");
    expect(def.model).toEqual({ name: "qwen2.5-coder:7b", base_url: "http://127.0.0.1:9842/v1" });
  });

  it("asks before running shell commands", () => {
    expect(def.tool_policies.shell.type).toBe("always_ask");
  });

  it("uses a harness file that exists and ends with the untrusted-content paragraph", () => {
    expect(existsSync(join(root, "agents", def.harness))).toBe(true);
    expect(body!.trim().endsWith("Ask the operator when in doubt.")).toBe(true);
    expect(body).toMatch(/untrusted data/);
  });

  it("does not claim a harness the build could not provide", () => {
    expect(def.harness).toBe("../harnesses/local-shim/harness.ts");
    expect(readFileSync(join(root, "harnesses", "local-shim", "harness.ts"), "utf8")).toMatch(
      /no default export/,
    );
  });
});

describe("chat-completions adapter", () => {
  it("converts a conversation with tool calls to chat messages", () => {
    const messages = toChatMessages([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "c1", name: "a", arguments: '{"x":1}' },
      { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "one" },
      { type: "function_call_output", call_id: "c2", output: "two" },
      { role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: '{"x":1}' } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "one" },
      { role: "tool", tool_call_id: "c2", content: "two" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("converts a tool-call response and a text response back, with usage", () => {
    const call = fromChatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c9", type: "function", function: { name: "t", arguments: '{"a":2}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    expect(call.output).toEqual([
      { type: "function_call", call_id: "c9", name: "t", arguments: '{"a":2}' },
    ]);
    expect(call.usage).toEqual({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });

    const text = fromChatResponse({
      choices: [{ message: { role: "assistant", content: "hello" } }],
    });
    expect(text.output[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    });
    expect(text.usage).toBeUndefined();
  });

  it("rejects a response without a choice", () => {
    expect(() => fromChatResponse({})).toThrow(LocalModelError);
    expect(() => fromChatResponse({ choices: [{}] })).toThrow(LocalModelError);
  });

  it("refuses a model URL that is not on loopback", () => {
    for (const url of [
      "http://example.org/v1",
      "http://192.168.1.10:9842/v1",
      "http://0.0.0.0:9842/v1",
      "not a url",
    ]) {
      expect(() => chatCallModel({ baseUrl: url, model: "m" }), url).toThrow(LocalModelError);
    }
    expect(() => chatCallModel({ baseUrl: "http://127.0.0.1:9842/v1", model: "m" })).not.toThrow();
    expect(() => chatCallModel({ baseUrl: "http://localhost:9842/v1", model: "m" })).not.toThrow();
  });
});

describe("a local model drives the turn loop", () => {
  it("completes an 8-step scenario against an OpenAI-compatible endpoint", async () => {
    const baseUrl = await startModel();
    const ledger = join(mkdtempSync(join(tmpdir(), "lh-")), "l.jsonl");
    const t = thread("go [[scenario:steps8]]");
    const r = await runScriptedTurn(
      ports(t, chatCallModel({ baseUrl, model: "qwen2.5-coder:7b" }), async (c) =>
        JSON.stringify(appendLedger(ledger, { tool_call_id: c.id, seq: c.args.seq as number })),
      ),
    );
    expect(r.toolCalls).toBe(8);
    expect(r.text).toMatch(/Completed all 8 steps/);
    expect(ledgerStats(ledger)).toMatchObject({ entries: 8, unique: 8, duplicates: 0 });
  });

  it("sends the tool declarations it was given", async () => {
    const baseUrl = await startModel();
    const seen: unknown[] = [];
    const fetchSpy: typeof fetch = async (url, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return fetch(url, init);
    };
    const tools = [
      { type: "function", function: { name: "ledger_append", parameters: { type: "object" } } },
    ];
    await chatCallModel({ baseUrl, model: "m", tools, fetch: fetchSpy })([
      { role: "user", content: "x [[scenario:plain]]" },
    ]);
    expect((seen[0] as any).tools).toEqual(tools);
    expect((seen[0] as any).model).toBe("m");
  });

  it("retries injected 429 and 500 responses and still finishes", async () => {
    const baseUrl = await startModel({ rate_limit_every: 3, error_every: 4 });
    const slept: number[] = [];
    const t = thread("go [[scenario:steps8]]");
    const ledger = join(mkdtempSync(join(tmpdir(), "lh-")), "l.jsonl");
    const r = await runScriptedTurn(
      ports(
        t,
        chatCallModel({ baseUrl, model: "m", sleep: async (ms) => void slept.push(ms) }),
        async (c) =>
          JSON.stringify(appendLedger(ledger, { tool_call_id: c.id, seq: c.args.seq as number })),
      ),
    );
    expect(r.text).toMatch(/Completed all 8 steps/);
    expect(slept.length).toBeGreaterThan(0);
    expect(ledgerStats(ledger)).toMatchObject({ unique: 8, duplicates: 0 });
  });

  it("reports an unreachable model clearly after the retries", async () => {
    const call = chatCallModel({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      retries: 1,
      sleep: async () => {},
    });
    await expect(call([{ role: "user", content: "hi" }])).rejects.toThrow(
      /local model unavailable at http:\/\/127\.0\.0\.1:1\/v1/,
    );
  });

  it("surfaces a 400 from the model without retrying", async () => {
    const baseUrl = await startModel();
    const call = chatCallModel({ baseUrl, model: "m", sleep: async () => {} });
    await expect(
      call([{ role: "user", content: "x [[scenario:no-such-scenario]]" }]),
    ).rejects.toThrow(/400/);
  });
});
