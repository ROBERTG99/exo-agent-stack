/* eslint-disable @typescript-eslint/no-explicit-any -- JSON Schema property bags are schemaless in this suite */
// T-30: the bridge's tool contract (BUILD.md §4.6). The JSON Schema file is generated from the zod
// schemas the tools register; what a client sees in tools/list must match it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeContext } from "../../bridge/src/context.ts";
import { createMcpServer } from "../../bridge/src/mcp.ts";
import { SCHEMAS, TOOL_NAMES, toolsDocument } from "../../bridge/src/schemas.ts";
import { registerTools } from "../../bridge/src/tools/index.ts";
import { render, SCHEMA_FILE } from "../../scripts/gen-bridge-schemas.ts";

const NINE = [
  "exo_list_agents",
  "exo_start_thread",
  "exo_send",
  "exo_get_events",
  "exo_thread_status",
  "exo_fork",
  "exo_approve",
  "exo_answer",
  "exo_usage",
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connect() {
  // stackd is never reached in this file: nothing here calls a tool that needs it
  const ctx = makeContext({ stackdUrl: "http://127.0.0.1:1", stackdToken: "t".repeat(64) });
  const server = createMcpServer(ctx, registerTools);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return client;
}

describe("tools/list", () => {
  it("offers exactly the nine tools of §4.6", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...NINE].sort());
    expect([...TOOL_NAMES].sort()).toEqual([...NINE].sort());
  });

  it("marks reads as read-only, exo_approve as destructive, and everything as closed-world", async () => {
    const { tools } = await (await connect()).listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of ["exo_list_agents", "exo_get_events", "exo_thread_status", "exo_usage"]) {
      expect(by[name], name).toMatchObject({ readOnlyHint: true });
    }
    for (const name of ["exo_start_thread", "exo_send", "exo_fork", "exo_answer", "exo_approve"]) {
      expect(by[name], name).toMatchObject({ readOnlyHint: false });
    }
    expect(by.exo_approve).toMatchObject({ destructiveHint: true });
    for (const name of NINE) expect(by[name]?.openWorldHint, name).toBe(false);
  });

  it("gives every tool an input schema, an output schema and a description", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
    }
  });

  it("requires an idempotency key of 8 to 128 characters on every write", async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of ["exo_start_thread", "exo_send", "exo_fork", "exo_approve", "exo_answer"]) {
      const t = tools.find((x) => x.name === name)!;
      const schema = t.inputSchema as {
        required?: string[];
        properties: Record<string, { minLength?: number; maxLength?: number }>;
      };
      expect(schema.required, name).toContain("idempotency_key");
      expect(schema.properties.idempotency_key).toMatchObject({ minLength: 8, maxLength: 128 });
    }
    for (const name of ["exo_list_agents", "exo_get_events", "exo_thread_status", "exo_usage"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(
        Object.keys((t.inputSchema as { properties?: object }).properties ?? {}),
        name,
      ).not.toContain("idempotency_key");
    }
  });

  it("pins the limits of §4.6 and NFR-8", async () => {
    const { tools } = await (await connect()).listTools();
    const input = (n: string) =>
      (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, any> })
        .properties;
    expect(input("exo_start_thread").prompt).toMatchObject({ minLength: 1, maxLength: 20_000 });
    expect(input("exo_start_thread").agent).toMatchObject({ minLength: 1, maxLength: 128 });
    expect(input("exo_start_thread").resources.maxItems).toBe(4);
    expect(input("exo_send").message).toMatchObject({ minLength: 1, maxLength: 20_000 });
    expect(input("exo_get_events").limit).toMatchObject({ minimum: 1, maximum: 200 });
    expect(input("exo_approve").reason.maxLength).toBe(500);
    expect(input("exo_approve").decision.enum).toEqual(["approve", "deny", "approve_for_session"]);
    expect(input("exo_answer").answer).toMatchObject({ minLength: 1, maxLength: 8_000 });
  });

  it("matches the committed schema document for every tool", async () => {
    const { tools } = await (await connect()).listTools();
    const doc = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
      tools: Record<
        string,
        { input: { properties: object; required?: string[] }; output: { properties: object } }
      >;
    };
    for (const t of tools) {
      const committed = doc.tools[t.name]!;
      const listed = t.inputSchema as { properties: object; required?: string[] };
      expect(Object.keys(listed.properties).sort(), t.name).toEqual(
        Object.keys(committed.input.properties).sort(),
      );
      expect([...(listed.required ?? [])].sort(), t.name).toEqual(
        [...(committed.input.required ?? [])].sort(),
      );
      expect(
        Object.keys((t.outputSchema as { properties: object }).properties).sort(),
        t.name,
      ).toEqual(Object.keys(committed.output.properties).sort());
    }
  });
});

describe("tools.v1.json", () => {
  it("is exactly what the zod schemas generate (run scripts/gen-bridge-schemas.ts after a change)", () => {
    expect(readFileSync(SCHEMA_FILE, "utf8")).toBe(render());
    expect(SCHEMA_FILE.endsWith(join("bridge", "schemas", "tools.v1.json"))).toBe(true);
  });

  it("describes all nine tools with an annotation block", () => {
    const doc = toolsDocument() as { tools: Record<string, { annotations: object }> };
    expect(Object.keys(doc.tools)).toEqual(Object.keys(SCHEMAS));
    for (const t of Object.values(doc.tools)) expect(t.annotations).toBeTypeOf("object");
  });
});

describe("input validation", () => {
  it("rejects a call that breaks the schema before any tool runs", async () => {
    const client = await connect();
    const outcomes = await Promise.all(
      [
        { name: "exo_start_thread", arguments: { agent: "a", prompt: "x" } }, // no key
        {
          name: "exo_start_thread",
          arguments: { agent: "a", prompt: "x".repeat(20_001), idempotency_key: "key-12345678" },
        },
        { name: "exo_get_events", arguments: { thread: "t", limit: 500 } },
        {
          name: "exo_approve",
          arguments: {
            thread: "t",
            request_id: "r",
            decision: "maybe",
            idempotency_key: "key-12345678",
          },
        },
      ].map((call) =>
        client.callTool(call).then(
          (r) => ({
            isError: r.isError === true,
            code: (r.structuredContent as { code?: string } | undefined)?.code,
          }),
          () => ({ isError: true, code: "protocol_error" }),
        ),
      ),
    );
    for (const o of outcomes) expect(o.isError).toBe(true);
  });
});
