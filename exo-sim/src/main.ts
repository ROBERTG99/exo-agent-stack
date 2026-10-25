// Entry point: `tsx exo-sim/src/main.ts`. Binds loopback only (EXOS_LISTEN_HOST / EXOS_IN_CONTAINER
// follow packages/common).
import { fileURLToPath } from "node:url";
import { parsePort, resolveListenHost } from "@exos/common";
import { createExoSim, type ExoSim } from "./server.ts";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<ExoSim> {
  const host = resolveListenHost(env);
  const port = parsePort(env.EXOS_EXO_PORT, 9810);
  const sim = await createExoSim({
    dataDir: env.EXO_SIM_DATA_DIR || ".exos-state/exo-sim",
    modelUrl:
      env.EXO_SIM_MODEL_URL || `http://127.0.0.1:${parsePort(env.EXOS_FAKE_MODEL_PORT, 9840)}`,
    stepDelayMs: env.EXO_SIM_STEP_DELAY_MS ? Number(env.EXO_SIM_STEP_DELAY_MS) : undefined,
    ledgerPath: env.EXOS_TEST_LEDGER || undefined,
  });
  await sim.app.listen({ host, port });
  console.log(JSON.stringify({ level: "info", service: "exo-sim", listening: `${host}:${port}` }));
  return sim;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
