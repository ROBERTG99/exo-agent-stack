#!/usr/bin/env node
// Bundles <dir>/src/server.ts into <dir>/dist/server.mjs for the Docker images (the bridge also gets dist/stdio.js).
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

// The bridge also has a stdio entry, started by `.mcp.json` as `node bridge/dist/stdio.js`.
const entries = [{ in: "src/server.ts", out: "dist/server.mjs" }];
if (dir === "bridge") entries.push({ in: "src/stdio.ts", out: "dist/stdio.js" });

for (const entry of entries) {
  await build({
    entryPoints: [path.join(repo, dir, entry.in)],
    outfile: path.join(repo, dir, entry.out),
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
  console.log(`bundled ${dir}/${entry.in} -> ${dir}/${entry.out}`);
}
