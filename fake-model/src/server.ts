// Fake model server (BUILD.md §4.7, Appendix B): a deterministic stand-in for the model APIs.
// Scenarios in fake-model/scenarios/*.yaml are selected by a [[scenario:<id>]] marker in the first
// user message. The next step is derived only from the number of tool results already present in
// the conversation, so the server holds no per-conversation state and a replay after a crash
// yields exactly the step the original run would have taken.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { parsePort, resolveListenHost } from "@exos/common";
import { FaultInjector, parseFaults, type FaultConfig } from "./faults.ts";
import {
  buildChat,
  buildMessages,
  buildResponses,
  parseChat,
  parseMessages,
  parseResponses,
  type Built,
  type ParsedRequest,
} from "./formats.ts";
import { loadScenarios, nextStep, resolveScenario, type Scenario } from "./scenarios.ts";

export { loadScenarios } from "./scenarios.ts";
export type { FaultConfig } from "./faults.ts";

export interface FakeModelOptions {
  scenariosDir?: string;
  faults?: FaultConfig;
  /** Injected so tests do not wait for real latency. */
  sleep?: (ms: number) => Promise<void>;
}

interface Recorded {
  seq: number;
  method: string;
  path: string;
  headers: Record<string, string>;
}

const defaultScenariosDir = () => fileURLToPath(new URL("../scenarios", import.meta.url));

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { type: "invalid_request_error", code, message } });
}

export async function buildFakeModel(opts: FakeModelOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const library = loadScenarios(opts.scenariosDir ?? defaultScenariosDir());
  const faults = new FaultInjector(opts.faults ?? {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let log: Recorded[] = [];
  let seq = 0;

  app.get("/healthz", async () => ({ status: "ok", service: "fake-model" }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: ["fake-model", "claude-fake"].map((id) => ({
      id,
      object: "model",
      owned_by: "exo-agent-stack",
    })),
  }));

  // Test-only: which headers did the model API receive (Mode B placeholder substitution, FR-5)?
  // Bodies are never stored.
  app.get("/__test/requests", async (request) => {
    const path = (request.query as { path?: string }).path;
    return { requests: path ? log.filter((r) => r.path === path) : log };
  });
  app.post("/__test/reset", async () => {
    log = [];
    seq = 0;
    faults.reset();
    return { ok: true };
  });

  function register<T extends ParsedRequest>(
    path: string,
    parse: (body: unknown) => T | null,
    build: (req: T, step: ReturnType<typeof nextStep>, scenario: Scenario) => Built,
  ) {
    app.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parse(request.body);
      if (!parsed)
        return apiError(reply, 400, "invalid_request", `${path}: malformed request body`);

      log.push({
        seq: ++seq,
        method: "POST",
        path,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([k, v]) => [
            k.toLowerCase(),
            Array.isArray(v) ? v.join(", ") : String(v),
          ]),
        ),
      });

      const forced = request.headers["x-fake-fault"];
      const fault = faults.next(typeof forced === "string" ? forced : undefined);
      if (faults.latencyMs > 0) await sleep(faults.latencyMs);
      if (fault) {
        for (const [k, v] of Object.entries(fault.headers)) reply.header(k, v);
        return reply.code(fault.status).send({
          error: {
            type: "fake_fault",
            code: fault.status === 429 ? "rate_limited" : "server_error",
            message: "injected fault",
          },
        });
      }

      const scenario = resolveScenario(library, parsed.scenarioId);
      if (!scenario) {
        return apiError(reply, 400, "unknown_scenario", `unknown scenario "${parsed.scenarioId}"`);
      }
      if (scenario.delay_ms > 0) await sleep(scenario.delay_ms);

      const built = build(parsed, nextStep(scenario, parsed.toolResults), scenario);
      reply.header("content-type", built.contentType);
      return reply.send(built.body);
    });
  }

  register("/v1/responses", parseResponses, buildResponses);
  register("/v1/chat/completions", parseChat, buildChat);
  register("/v1/messages", parseMessages, buildMessages);

  return app;
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const host = resolveListenHost(env);
  const port = parsePort(env.EXOS_FAKE_MODEL_PORT, 9840);
  const app = await buildFakeModel({
    scenariosDir: env.FAKE_MODEL_SCENARIOS_DIR || undefined,
    faults: parseFaults(env.FAKE_MODEL_FAULTS),
  });
  await app.listen({ host, port });
  console.log(
    JSON.stringify({ level: "info", service: "fake-model", listening: `${host}:${port}` }),
  );
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
