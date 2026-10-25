// Fake model server (skeleton). The /v1/responses, /v1/chat/completions and /v1/messages
// scenarios arrive in T-16; this version proves the service, health and loopback wiring.
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { parsePort, resolveListenHost } from "@exos/common";

export async function buildFakeModel(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok", service: "fake-model" }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: [{ id: "fake-model", object: "model", owned_by: "exo-agent-stack" }],
  }));

  return app;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const host = resolveListenHost(env);
  const port = parsePort(env.EXOS_FAKE_MODEL_PORT, 9840);
  const app = await buildFakeModel();
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
