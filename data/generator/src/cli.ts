// `make seed`: write the datasets and fixtures. `--check` verifies the checked-in files instead.
import { resolve } from "node:path";
import { checkAll, generateAll, writeAll } from "./index.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const root = resolve(outIndex >= 0 ? (args[outIndex + 1] ?? ".") : ".");
const files = generateAll();

if (args.includes("--check")) {
  const mismatches = checkAll(root, files);
  for (const m of mismatches) console.error(`${m.reason}: ${m.path}`);
  if (mismatches.length > 0) process.exit(1);
  console.log(`seed ok: ${files.size} files match gen.v1`);
} else {
  writeAll(root, files);
  console.log(`seed written: ${files.size} files under ${root}`);
}
