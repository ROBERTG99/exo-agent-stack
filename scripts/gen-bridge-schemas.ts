// Writes bridge/schemas/tools.v1.json from the zod schemas in bridge/src/schemas.ts.
// Run with `pnpm exec tsx scripts/gen-bridge-schemas.ts`; tests/contract/bridge-tools.test.ts fails
// when the committed file differs from what the schemas produce.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolsDocument } from "../bridge/src/schemas.ts";

export const SCHEMA_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bridge/schemas/tools.v1.json",
);

export const render = (): string => `${JSON.stringify(toolsDocument(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(dirname(SCHEMA_FILE), { recursive: true });
  writeFileSync(SCHEMA_FILE, render());
  console.log(`wrote ${SCHEMA_FILE}`);
}
