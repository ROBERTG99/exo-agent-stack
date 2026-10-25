/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC and settings payloads are schemaless in these assertions */
import { mkdtempSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { toExoToolName, toMcpDecision } from "../../../harnesses/claude-host/approvals.ts";
import { ApprovalBroker, askBroker } from "../../../harnesses/claude-host/broker.ts";

const dirs = () => mkdtempSync(join(tmpdir(), "ap-"));
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

describe("tool names and decisions", () => {
  it("maps Claude Code tool names to claude.<Tool>", () => {
    expect(toExoToolName("Bash")).toBe("claude.Bash");
    expect(toExoToolName("WebFetch")).toBe("claude.WebFetch");
    expect(toExoToolName("mcp__playwright__browser_click")).toBe(
      "claude.mcp__playwright__browser_click",
    );
  });

  it.each(["", " ", "Bash rm", "x".repeat(129), "a/b", "../x"])(
    "rejects the tool name %j",
    (name) => {
      expect(() => toExoToolName(name)).toThrow();
    },
  );

  it("builds Claude Code's allow and deny replies", () => {
    expect(toMcpDecision({ approved: true }, { command: "ls" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(toMcpDecision({ approved: false, reason: "not now" }, {})).toEqual({
      behavior: "deny",
      message: "not now",
    });
    expect(toMcpDecision({ approved: false }, {})).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/denied/i),
    });
  });
});

describe("approval broker (unix socket between the harness and the MCP server)", () => {
  async function start(authorize: ConstructorParameters<typeof ApprovalBroker>[0]) {
    const socket = join(dirs(), "b.sock");
    const broker = new ApprovalBroker(authorize);
    await broker.listen(socket);
    closers.push(() => broker.close());
    return { socket, broker };
  }

  it("forwards the request and returns the decision", async () => {
    const seen: unknown[] = [];
    const { socket } = await start(async (req) => {
      seen.push(req);
      return { approved: true };
    });
    const reply = await askBroker(socket, { tool_name: "Bash", input: { command: "git push" } });
    expect(reply).toEqual({ behavior: "allow", updatedInput: { command: "git push" } });
    expect(seen).toEqual([{ name: "claude.Bash", arguments: { command: "git push" } }]);
  });

  it("returns a denial with the reason", async () => {
    const { socket } = await start(async () => ({ approved: false, reason: "dashboard only" }));
    expect(await askBroker(socket, { tool_name: "Bash", input: {} })).toEqual({
      behavior: "deny",
      message: "dashboard only",
    });
  });

  it("answers concurrent requests independently", async () => {
    const { socket } = await start(async (req) => {
      await new Promise((r) => setTimeout(r, req.name === "claude.A" ? 60 : 5));
      return { approved: req.name === "claude.B" };
    });
    const [a, b] = await Promise.all([
      askBroker(socket, { tool_name: "A", input: {} }),
      askBroker(socket, { tool_name: "B", input: {} }),
    ]);
    expect(a.behavior).toBe("deny");
    expect(b.behavior).toBe("allow");
  });

  it("fails closed when the authorizer throws", async () => {
    const { socket } = await start(async () => {
      throw new Error("exo down");
    });
    expect(await askBroker(socket, { tool_name: "Bash", input: {} })).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/approval failed/i),
    });
  });

  it("fails closed when the broker is unreachable", async () => {
    const reply = await askBroker(join(dirs(), "missing.sock"), { tool_name: "Bash", input: {} });
    expect(reply).toEqual({
      behavior: "deny",
      message: expect.stringMatching(/approval service unavailable/i),
    });
  });

  it("removes the socket on close", async () => {
    const { socket, broker } = await start(async () => ({ approved: true }));
    expect(existsSync(socket)).toBe(true);
    await broker.close();
    expect(existsSync(socket)).toBe(false);
  });

  it("denies a request with an invalid tool name without calling the authorizer", async () => {
    let calls = 0;
    const { socket } = await start(async () => {
      calls++;
      return { approved: true };
    });
    expect((await askBroker(socket, { tool_name: "../etc", input: {} })).behavior).toBe("deny");
    expect(calls).toBe(0);
  });
});

describe("approvals MCP server (what Claude Code calls for each permission prompt)", () => {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const server = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "harnesses",
    "claude-host",
    "approvals-mcp.ts",
  );

  async function connect(socket: string) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsx, server],
      env: { PATH: process.env.PATH ?? "", EXOS_APPROVALS_SOCKET: socket },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    closers.push(() => client.close());
    return client;
  }
  const decision = (res: any) => JSON.parse(res.content[0].text);

  it("exposes a single tool named prompt", async () => {
    const socket = join(dirs(), "b.sock");
    const broker = new ApprovalBroker(async () => ({ approved: true }));
    await broker.listen(socket);
    closers.push(() => broker.close());
    const tools = await (await connect(socket)).listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["prompt"]);
  });

  it("allows and denies according to the broker", async () => {
    const socket = join(dirs(), "b.sock");
    const broker = new ApprovalBroker(async (req) => ({
      approved: req.name === "claude.Edit",
      reason: "no",
    }));
    await broker.listen(socket);
    closers.push(() => broker.close());
    const client = await connect(socket);
    const ok = await client.callTool({
      name: "prompt",
      arguments: { tool_name: "Edit", input: { file_path: "a.md" } },
    });
    expect(decision(ok)).toEqual({ behavior: "allow", updatedInput: { file_path: "a.md" } });
    const no = await client.callTool({
      name: "prompt",
      arguments: { tool_name: "Bash", input: { command: "git push" } },
    });
    expect(decision(no)).toEqual({ behavior: "deny", message: "no" });
  });

  it("denies when the broker is gone and when the arguments are malformed", async () => {
    const client = await connect(join(dirs(), "none.sock"));
    const gone = await client.callTool({
      name: "prompt",
      arguments: { tool_name: "Bash", input: {} },
    });
    expect(decision(gone).behavior).toBe("deny");
    const bad = await client.callTool({ name: "prompt", arguments: { tool_name: 5 } });
    expect(bad.isError === true || decision(bad).behavior === "deny").toBe(true);
  });
});
