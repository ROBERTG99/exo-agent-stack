import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { parsePort, resolveListenHost } from "@exos/common";
import { ExoUnavailableError, exoReachable, listExoAgents } from "./exo.ts";
import { problem } from "./problem.ts";
import { ensureLocalToken, tokenMatches } from "./token.ts";

export interface StackdOptions {
  stateDir: string;
  exoUrl: string;
  /** Port the browser sees (defaults to the socket's local port). */
  publicPort?: number;
  dashboardPort?: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A browser Origin is allowed when it is a loopback name on one of the given ports. */
function originAllowed(origin: string, ports: number[]): boolean {
  try {
    const u = new URL(origin);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const name = u.hostname === "[::1]" || u.hostname === "::1" ? "[::1]" : u.hostname;
    return LOOPBACK_NAMES.has(name) && ports.includes(port);
  } catch {
    return false;
  }
}

function parseHostHeader(
  host: string | undefined,
): { name: string; port: number | undefined } | null {
  if (!host) return null;
  const m = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : undefined };
}

export async function buildStackd(
  opts: StackdOptions,
): Promise<{ app: FastifyInstance; token: string }> {
  const token = ensureLocalToken(opts.stateDir);
  const dashboardPort = opts.dashboardPort ?? 9800;
  const app = Fastify({ logger: false });

  // DNS-rebinding and CSRF defence (BUILD.md §4.6): Host must be a loopback name on our port,
  // and a cross-site Origin is refused.
  app.addHook("onRequest", async (request, reply) => {
    const host = parseHostHeader(request.headers.host);
    const expectedPort = opts.publicPort ?? request.raw.socket.localPort;
    if (!host || !LOOPBACK_NAMES.has(host.name) || host.port !== expectedPort) {
      return problem(
        reply,
        403,
        "forbidden_host",
        "Forbidden",
        "Host header must be 127.0.0.1 or localhost on the stackd port",
      );
    }
    const origin = request.headers.origin;
    if (origin) {
      const ok = originAllowed(
        origin,
        [expectedPort, dashboardPort].filter((p): p is number => p !== undefined),
      );
      if (!ok)
        return problem(
          reply,
          403,
          "forbidden_origin",
          "Forbidden",
          "Cross-site Origin is not allowed",
        );
    }
  });

  const requireToken = async (
    request: { headers: { authorization?: string } },
    reply: Parameters<typeof problem>[0],
  ) => {
    const presented = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!tokenMatches(token, presented)) {
      return problem(
        reply,
        401,
        "unauthorized",
        "Unauthorized",
        "A valid local bearer token is required",
      );
    }
  };

  app.get("/api/v1/health", async () => {
    const reachable = await exoReachable(opts.exoUrl, opts.fetchImpl);
    return { status: reachable ? "ok" : "degraded", service: "stackd", exo: { reachable } };
  });

  app.get("/api/v1/agents", { preHandler: requireToken }, async (_request, reply) => {
    try {
      return { agents: await listExoAgents(opts.exoUrl, opts.fetchImpl) };
    } catch (err) {
      if (err instanceof ExoUnavailableError) {
        return problem(reply, 503, "exo_unavailable", "Exo unavailable", err.message);
      }
      throw err;
    }
  });

  return { app, token };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const host = resolveListenHost(env);
  const port = parsePort(env.EXOS_STACKD_PORT, 9812);
  const exoPort = parsePort(env.EXOS_EXO_PORT, 9810);
  const { app } = await buildStackd({
    stateDir: env.EXOS_STATE_DIR || ".exos-state",
    exoUrl: env.EXOS_EXO_URL || `http://127.0.0.1:${exoPort}/exo`,
    publicPort: port,
    dashboardPort: parsePort(env.EXOS_DASHBOARD_PORT, 9800),
  });
  await app.listen({ host, port });
  console.log(JSON.stringify({ level: "info", service: "stackd", listening: `${host}:${port}` }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
