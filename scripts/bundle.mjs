#!/usr/bin/env node
// Bundles <dir>/src/server.ts into <dir>/dist/server.mjs for the Docker images.
// Usage: node scripts/bundle.mjs stackd
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir || !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(dir)) {
  console.error("usage: node scripts/bundle.mjs <package-dir>");
  process.exit(2);
}

await build({
  entryPoints: [path.join(repo, dir, "src/server.ts")],
  outfile: path.join(repo, dir, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // Native modules stay external and are installed next to the bundle by the Dockerfile.
  external: ["better-sqlite3"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
console.log(`bundled ${dir} -> ${dir}/dist/server.mjs`);
