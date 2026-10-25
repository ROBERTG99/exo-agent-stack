// T-29: the bridge's two transports and their guards (BUILD.md §4.6, FR-8).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeContext } from "../../bridge/src/context.ts";
import { loadToken } from "../../bridge/src/auth.ts";
import { LIMITS } from "../../bridge/src/limits.ts";
import { buildBridgeHttp } from "../../bridge/src/server.ts";
import type { Register } from "../../bridge/src/mcp.ts";

const root = join(import.meta.dirname, "..", "..");
const TOKEN = "t".repeat(64);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const register: Register = (server) => {
  server.registerTool(
    "ping",
    {
      description: "Echoes back",
      inputSchema: { word: z.string().max(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ word }) => ({ content: [{ type: "text", text: `pong ${word}` }] }),
  );
};

async function bridge() {
  const app = await buildBridgeHttp({
    token: TOKEN,
    context: makeContext({ stackdUrl: "http://127.0.0.1:1", stackdToken: TOKEN }),
    register,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const address = app.server.address() as AddressInfo;
  return { app, port: address.port, address, url: `http://127.0.0.1:${address.port}` };
}

/** A raw HTTP call, so the Host header can be chosen. */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "POST",
        path: opts.path ?? "/mcp",
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("HTTP transport", () => {
  it("binds the loopback interface only", async () => {
    const b = await bridge();
    expect(b.address.address).toBe("127.0.0.1");
  });

  it("serves MCP to a real client that presents the token: list tools and call one", async () => {
    const b = await bridge();
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${b.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping"]);
    const result = await client.callTool({ name: "ping", arguments: { word: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "pong hi" }]);
  });

  it("serves several clients at once without sharing state", async () => {
    const b = await bridge();
    const make = async () => {
      const c = new Client({ name: "test", version: "1" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${b.url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
      );
      cleanups.push(() => c.close());
      return c;
    };
    const clients = await Promise.all([make(), make(), make()]);
    const answers = await Promise.all(
      clients.map((c, i) => c.callTool({ name: "ping", arguments: { word: String(i) } })),
    );
    expect(answers.map((a) => (a.content as Array<{ text: string }>)[0]!.text)).toEqual([
      "pong 0",
      "pong 1",
      "pong 2",
    ]);
  });

  it("answers 401 without a token or with a wrong one, and never reads the message", async () => {
    const b = await bridge();
    const host = { host: `127.0.0.1:${b.port}` };
    for (const headers of [
      { ...MCP_HEADERS, ...host },
      { ...MCP_HEADERS, ...host, authorization: "Bearer wrong" },
      { ...MCP_HEADERS, ...host, authorization: `Basic ${TOKEN}` },
    ]) {
      const r = await raw(b.port, { headers, body: initialize });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body).error.data.code).toBe("unauthorized");
    }
  });

  it("answers 403 to a Host that is not a loopback name on the bridge port (DNS rebinding)", async () => {
    const b = await bridge();
    for (const host of [
      "evil.example",
      `evil.example:${b.port}`,
      `127.0.0.1:${b.port + 1}`,
      "127.0.0.1",
    ]) {
      const r = await raw(b.port, {
        headers: { ...MCP_HEADERS, host, authorization: `Bearer ${TOKEN}` },
        body: initialize,
      });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error.data.code).toBe("forbidden_host");
    }
    const ok = await raw(b.port, {
      headers: { ...MCP_HEADERS, host: `localhost:${b.port}`, authorization: `Bearer ${TOKEN}` },
      body: initialize,
    });
    expect(ok.status).toBe(200);
  });

  it("answers 403 to a cross-site Origin and accepts a loopback one", async () => {
    const b = await bridge();
    const base = { ...MCP_HEADERS, host: `127.0.0.1:${b.port}`, authorization: `Bearer ${TOKEN}` };
    const evil = await raw(b.port, {
      headers: { ...base, origin: "https://evil.example" },
      body: initialize,
    });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body).error.data.code).toBe("forbidden_origin");
    const wrongPort = await raw(b.port, {
      headers: { ...base, origin: "http://127.0.0.1:9999" },
      body: initialize,
    });
    expect(wrongPort.status).toBe(403);
    const local = await raw(b.port, {
      headers: { ...base, origin: `http://localhost:${b.port}` },
      body: initialize,
    });
    expect(local.status).toBe(200);
  });

  it("refuses a body over the limit with 413, and malformed JSON with 400", async () => {
    const b = await bridge();
    const headers = {
      ...MCP_HEADERS,
      host: `127.0.0.1:${b.port}`,
      authorization: `Bearer ${TOKEN}`,
    };
    const big = await raw(b.port, {
      headers,
      body: JSON.stringify({ pad: "x".repeat(LIMITS.bodyBytes + 10) }),
    });
    expect(big.status).toBe(413);
    const bad = await raw(b.port, { headers, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("is stateless: GET and DELETE on /mcp are 405 for a signed-in client and 401 otherwise", async () => {
    const b = await bridge();
    const host = `127.0.0.1:${b.port}`;
    for (const method of ["GET", "DELETE"]) {
      expect(
        (await raw(b.port, { method, headers: { host, authorization: `Bearer ${TOKEN}` } })).status,
      ).toBe(405);
      expect((await raw(b.port, { method, headers: { host } })).status).toBe(401);
    }
  });

  it("answers the health probe without a token but still checks Host", async () => {
    const b = await bridge();
    const ok = await raw(b.port, {
      method: "GET",
      path: "/healthz",
      headers: { host: `127.0.0.1:${b.port}` },
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ status: "ok", service: "bridge" });
    expect(
      (await raw(b.port, { method: "GET", path: "/healthz", headers: { host: "evil.example" } }))
        .status,
    ).toBe(403);
  });
});

describe("stdio transport", () => {
  const stdioArgs = ["--import", "tsx", join(root, "bridge/src/stdio.ts")];

  it("completes the MCP handshake over stdin and stdout with a real client", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: stdioArgs,
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        EXOS_LOCAL_TOKEN: TOKEN,
        EXOS_STACKD_URL: "http://127.0.0.1:1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect(client.getServerVersion()).toMatchObject({ name: "exos-bridge" });
    // the tools themselves are listed in tests/contract/bridge-tools.test.ts (T-30)
  }, 30_000);

  it("exits with a clear message on stderr and nothing on stdout when there is no token", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, stdioArgs, {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", EXOS_STATE_DIR: "/nonexistent-state-dir" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/no local token/);
    expect(err).not.toContain(TOKEN);
  }, 30_000);

  it("rejects a token that is too short", () => {
    expect(() => loadToken({ EXOS_LOCAL_TOKEN: "short" })).toThrow(/too short/);
    expect(loadToken({ EXOS_LOCAL_TOKEN: TOKEN })).toBe(TOKEN);
  });
});
