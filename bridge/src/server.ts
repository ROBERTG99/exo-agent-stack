// The bridge over HTTP at 127.0.0.1:9811/mcp (stateless streamable HTTP), for Cursor and other
// clients that connect to a URL. Binds loopback only; every request is checked for Host, Origin and
// the bearer token before an MCP message is read.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parsePort, resolveListenHost } from "@exos/common";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { checkRequest, loadToken } from "./auth.ts";
import { makeContext, type BridgeContext } from "./context.ts";
import { LIMITS } from "./limits.ts";
import { createMcpServer, type Register } from "./mcp.ts";
import { registerTools } from "./tools/index.ts";

export interface BridgeHttpOptions {
  /** Token clients must present. */
  token: string;
  /** The port clients see (Host header); defaults to the socket's local port. */
  publicPort?: number;
  context: BridgeContext;
  register?: Register;
}

const problem = (status: number, code: string, message: string) => ({
  jsonrpc: "2.0",
  error: { code: -32000, message, data: { code, status } },
  id: null,
});

export async function buildBridgeHttp(opts: BridgeHttpOptions): Promise<FastifyInstance> {
  const register = opts.register ?? registerTools;
  const app = Fastify({ logger: false, bodyLimit: LIMITS.bodyBytes, forceCloseConnections: true });

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413)
      return reply.code(413).send(problem(413, "payload_too_large", "request body is too large"));
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send(problem(status, "invalid_input", "malformed request"));
    }
    return reply.code(500).send(problem(500, "internal_error", "internal error"));
  });

  const guard = (request: {
    headers: Record<string, string | string[] | undefined>;
    raw: { socket: { localPort?: number } };
  }) =>
    checkRequest(
      {
        host: request.headers.host as string | undefined,
        origin: request.headers.origin as string | undefined,
        authorization: request.headers.authorization as string | undefined,
      },
      { token: opts.token, port: opts.publicPort ?? request.raw.socket.localPort ?? 0 },
    );

  app.get("/healthz", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok && auth.status === 403)
      return reply.code(403).send(problem(403, auth.code, auth.message));
    return { status: "ok", service: "bridge" };
  });

  app.post("/mcp", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok)
      return reply.code(auth.status).send(problem(auth.status, auth.code, auth.message));

    const server = createMcpServer(opts.context, register);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: there is no session to resume or end, and no server-initiated stream.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (request, reply) => {
        const auth = guard(request);
        if (!auth.ok)
          return reply.code(auth.status).send(problem(auth.status, auth.code, auth.message));
        return reply
          .code(405)
          .header("allow", "POST")
          .send(problem(405, "method_not_allowed", "use POST"));
      },
    });
  }
  return app;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const host = resolveListenHost(env);
  const port = parsePort(env.EXOS_BRIDGE_PORT, 9811);
  const token = loadToken(env);
  const app = await buildBridgeHttp({
    token,
    publicPort: port,
    context: makeContext({
      stackdUrl: env.EXOS_STACKD_URL || `http://127.0.0.1:${parsePort(env.EXOS_STACKD_PORT, 9812)}`,
      stackdToken: token,
      dashboardUrl: `http://127.0.0.1:${parsePort(env.EXOS_DASHBOARD_PORT, 9800)}`,
    }),
  });
  await app.listen({ host, port });
  console.log(JSON.stringify({ level: "info", service: "bridge", listening: `${host}:${port}` }));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
