import { ExoClient, type ExoClientOptions } from "@exos/exo-client";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePort, resolveListenHost } from "@exos/common";
import { AgentDirectory } from "./agents.ts";
import { ApprovalQueue, loadDashboardOnly } from "./approvals.ts";
import { authenticate, setCookieHeader } from "./auth.ts";
import type { AppContext } from "./context.ts";
import {
  CreditGuard,
  DEFAULT_CREDIT_CONFIG,
  loadCreditConfig,
  type CreditConfig,
} from "./credit.ts";
import { appendAudit, defaultMigrationsDir, migrate, openDatabase, type Db } from "./db/index.ts";
import { toProblem } from "./errors.ts";
import { Idempotency } from "./idempotency.ts";
import { Meter } from "./meter.ts";
import { Supervisor, type SupervisorConfig } from "./supervisor.ts";
import { loadRates } from "./pricing.ts";
import { problem } from "./problem.ts";
import { registerApprovalRoutes } from "./routes/approvals.ts";
import { registerCreditRoutes } from "./routes/credit.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerThreadRoutes } from "./routes/threads.ts";
import { ensureDashboardToken, ensureLocalToken, tokenMatches } from "./token.ts";
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
  credit?: CreditConfig;
  /** Pass the meter runs at, in seconds; 0 (the default) leaves it to the caller (tests, `main`). */
  meterIntervalSeconds?: number;
  ratesFile?: string;
  /** Limits and timings of the supervisor (EXOS_MAX_ACTIVE_TURNS, EXOS_RECOVERY_MAX_ATTEMPTS). */
  supervisor?: Partial<SupervisorConfig>;
  /** Milliseconds between supervisor passes; 0 (the default) leaves ticking to the caller. */
  supervisorIntervalMs?: number;
  /** Tool patterns only a person in the dashboard may approve (EXOS_APPROVE_DASHBOARD_ONLY). */
  dashboardOnlyTools?: string[];
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
  /** Signs a person into the dashboard; keep it away from the bridge and from agents. */
  dashboardToken: string;
  db: Db;
  meter: Meter;
  credit: CreditGuard;
  approvals: ApprovalQueue;
  supervisor: Supervisor;
  ctx: AppContext;
  /** Closes the HTTP server and the database. */
  close(): Promise<void>;
}

export async function buildStackd(opts: StackdOptions): Promise<Stackd> {
  const token = ensureLocalToken(opts.stateDir);
  const dashboardToken = ensureDashboardToken(opts.stateDir);
  const dashboardPort = opts.dashboardPort ?? 9800;
  const clock = opts.clock ?? (() => new Date());
  const db = openDatabase(path.join(opts.stateDir, "stack.db"));
  migrate(db, defaultMigrationsDir());
  const exo = new ExoClient({ baseUrl: opts.exoUrl, fetch: opts.fetchImpl, ...opts.exoClient });
  const idem = new Idempotency(db, clock);
  idem.purge();
  const audit: AppContext["audit"] = (action, target, details, actor = "api") => {
    appendAudit(db, { actor, action, target, details }, clock);
  };
  const creditConfig = opts.credit ?? DEFAULT_CREDIT_CONFIG;
  // the credit guard is built before the supervisor it notifies
  const link: { supervisor?: Supervisor } = {};
  const credit = new CreditGuard({
    db,
    config: creditConfig,
    clock,
    onTransition: (t) => void link.supervisor?.onCredit(t),
    audit: (action, target, details) =>
      void appendAudit(db, { actor: "system", action, target, details }, clock),
  });
  const agents = new AgentDirectory(exo);
  const meter = new Meter({
    db,
    exo,
    agents,
    rates: loadRates(
      opts.ratesFile ?? fileURLToPath(new URL("../../pricing/api-rates.v1.json", import.meta.url)),
    ),
    cycle: creditConfig.cycle,
    clock,
    onIngested: (touched) => {
      for (const { pool } of touched) credit.refresh(pool);
    },
  });
  if ((opts.meterIntervalSeconds ?? 0) > 0) meter.start(opts.meterIntervalSeconds!);
  const approvals = new ApprovalQueue({
    db,
    exo,
    agents,
    dashboardOnly: opts.dashboardOnlyTools ?? loadDashboardOnly({}),
    clock,
  });
  const supervisor = new Supervisor({
    db,
    exo,
    agents,
    credit,
    approvals,
    config: opts.supervisor,
    clock,
    audit: (action, target, details) =>
      void appendAudit(db, { actor: "system", action, target, details }, clock),
  });
  link.supervisor = supervisor;
  if ((opts.supervisorIntervalMs ?? 0) > 0) supervisor.start(opts.supervisorIntervalMs!);
  const ctx: AppContext = {
    db,
    exo,
    idem,
    worktrees: new WorktreeManager(db, {
      baseDir: path.join(opts.stateDir, "worktrees"),
      allowedRoots: opts.allowedWorkspaceRoots ?? [],
    }),
    credit,
    meter,
    agents,
    supervisor,
    clock,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    audit,
  };
  const app = Fastify({ logger: false, forceCloseConnections: true });

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

  app.decorateRequest("actor", null);
  const requireToken = async (request: FastifyRequest, reply: FastifyReply) => {
    request.actor = authenticate({ api: token, dashboard: dashboardToken }, request);
    if (!request.actor) {
      return problem(
        reply,
        401,
        "unauthorized",
        "Unauthorized",
        "A valid local bearer token or dashboard session is required",
      );
    }
  };

  // The dashboard signs in once with the local token and then holds a session cookie.
  app.get("/login", async (request, reply) => {
    const presented = (request.query as { t?: string }).t;
    if (!tokenMatches(dashboardToken, presented)) {
      return problem(
        reply,
        401,
        "unauthorized",
        "Unauthorized",
        "A valid dashboard token is required",
      );
    }
    return reply
      .header("set-cookie", setCookieHeader(dashboardToken))
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(`${ctx.dashboardUrl}/`, 302);
  });

  app.get("/api/v1/health", async () => {
    const reachable = await exo.listAgents().then(
      () => true,
      () => false,
    );
    return {
      status: reachable ? "ok" : "degraded",
      service: "stackd",
      exo: { reachable },
      supervisor: supervisor.status(),
    };
  });

  app.get("/api/v1/agents", { preHandler: requireToken }, async () => ({
    agents: await agents.list(),
  }));

  registerCreditRoutes(app, ctx, requireToken, creditConfig);

  registerThreadRoutes(app, ctx, requireToken);
  registerEventRoutes(app, ctx, requireToken);
  registerApprovalRoutes(app, ctx, approvals, requireToken);

  app.addHook("onClose", async () => {
    meter.stop();
    supervisor.stop();
    db.close();
  });
  return {
    app,
    token,
    dashboardToken,
    db,
    meter,
    credit,
    approvals,
    supervisor,
    ctx,
    close: () => app.close(),
  };
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
    credit: loadCreditConfig(env),
    dashboardOnlyTools: loadDashboardOnly(env),
    supervisor: {
      maxActiveTurns: Number(env.EXOS_MAX_ACTIVE_TURNS || 4),
      recoveryMaxAttempts: Number(env.EXOS_RECOVERY_MAX_ATTEMPTS || 3),
    },
    supervisorIntervalMs: 1000,
    meterIntervalSeconds: Number(env.EXOS_METER_INTERVAL_SECONDS || 15),
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
