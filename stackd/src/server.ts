import { ExoClient, type ExoClientOptions } from "@exos/exo-client";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePort, resolveListenHost } from "@exos/common";
import { listAgents } from "./agents.ts";
import { openCredit, type AppContext, type CreditGate } from "./context.ts";
import { appendAudit, defaultMigrationsDir, migrate, openDatabase, type Db } from "./db/index.ts";
import { toProblem } from "./errors.ts";
import { Idempotency } from "./idempotency.ts";
import { problem } from "./problem.ts";
import { registerThreadRoutes } from "./routes/threads.ts";
import { ensureLocalToken, tokenMatches } from "./token.ts";
import { WorktreeManager } from "./worktrees.ts";

export interface StackdOptions {
  stateDir: string;
  exoUrl: string;
  /** Port the browser sees (defaults to the socket's local port). */
  publicPort?: number;
  dashboardPort?: number;
  fetchImpl?: typeof fetch;
  /** Directories a thread's workspace may live in (EXOS_ALLOWED_WORKSPACE_ROOTS); none by default. */
  allowedWorkspaceRoots?: string[];
  /** Overrides for the Exo client, for example `retries: 0` in tests. */
  exoClient?: Partial<ExoClientOptions>;
  credit?: CreditGate;
  clock?: () => Date;
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

export interface Stackd {
  app: FastifyInstance;
  token: string;
  db: Db;
  ctx: AppContext;
  /** Closes the HTTP server and the database. */
  close(): Promise<void>;
}

export async function buildStackd(opts: StackdOptions): Promise<Stackd> {
  const token = ensureLocalToken(opts.stateDir);
  const dashboardPort = opts.dashboardPort ?? 9800;
  const clock = opts.clock ?? (() => new Date());
  const db = openDatabase(path.join(opts.stateDir, "stack.db"));
  migrate(db, defaultMigrationsDir());
  const exo = new ExoClient({ baseUrl: opts.exoUrl, fetch: opts.fetchImpl, ...opts.exoClient });
  const idem = new Idempotency(db, clock);
  idem.purge();
  const ctx: AppContext = {
    db,
    exo,
    idem,
    worktrees: new WorktreeManager(db, {
      baseDir: path.join(opts.stateDir, "worktrees"),
      allowedRoots: opts.allowedWorkspaceRoots ?? [],
    }),
    credit: opts.credit ?? openCredit,
    clock,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    audit: (action, target, details) => {
      appendAudit(db, { actor: "api", action, target, details }, clock);
    },
  };
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    const known = toProblem(err);
    if (known) return problem(reply, known.status, known.code, known.title, known.detail);
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return problem(reply, status, "invalid_input", "Invalid request", (err as Error).message);
    }
    return problem(reply, 500, "internal_error", "Internal error");
  });

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
    const reachable = await exo.listAgents().then(
      () => true,
      () => false,
    );
    return { status: reachable ? "ok" : "degraded", service: "stackd", exo: { reachable } };
  });

  app.get("/api/v1/agents", { preHandler: requireToken }, async () => ({
    agents: await listAgents(exo),
  }));

  registerThreadRoutes(app, ctx, requireToken);

  app.addHook("onClose", async () => {
    db.close();
  });
  return { app, token, db, ctx, close: () => app.close() };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const host = resolveListenHost(env);
  const port = parsePort(env.EXOS_STACKD_PORT, 9812);
  const exoPort = parsePort(env.EXOS_EXO_PORT, 9810);
  const { app } = await buildStackd({
    stateDir: env.EXOS_STATE_DIR || ".exos-state",
    exoUrl: env.EXOS_EXO_URL || `http://127.0.0.1:${exoPort}/exo`,
    publicPort: port,
    dashboardPort: parsePort(env.EXOS_DASHBOARD_PORT, 9800),
    allowedWorkspaceRoots: (env.EXOS_ALLOWED_WORKSPACE_ROOTS ?? "")
      .split(path.delimiter)
      .filter(Boolean),
  });
  await app.listen({ host, port });
  console.log(JSON.stringify({ level: "info", service: "stackd", listening: `${host}:${port}` }));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
