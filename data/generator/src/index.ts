import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "@exos/common";
import { fixtureFiles } from "./fixtures.ts";
import { Rng } from "./prng.ts";
import { creditSuite } from "./suites/credit.ts";
import { delegationSuite } from "./suites/delegation.ts";
import { dualReviewSuite } from "./suites/dual-review.ts";
import { durabilitySuite } from "./suites/durability.ts";
import { policySuite } from "./suites/policy.ts";

export const SEED = 20261022;
export const GENERATOR_VERSION = "gen.v1";

const jsonl = (rows: object[]): string => rows.map((r) => canonicalJson(r)).join("\n") + "\n";

/** Generates every dataset and fixture as a map of repo-relative path to file content. */
export function generateAll(opts: { seed?: number } = {}): Map<string, string> {
  const seed = opts.seed ?? SEED;
  const root = new Rng(seed);
  const suites: [string, { dev: object[]; test: object[] }][] = [
    ["durability", durabilitySuite(root.child("durability"))],
    ["delegation", delegationSuite(root.child("delegation"))],
    ["policy", policySuite(root.child("policy"))],
    ["credit", creditSuite(root.child("credit"))],
    ["dual-review", dualReviewSuite(root.child("dual-review"))],
  ];

  const files = new Map<string, string>();
  const manifestFiles: Record<string, { sha256: string; cases: number }> = {};
  for (const [name, { dev, test }] of suites) {
    for (const [split, rows] of [
      ["dev", dev],
      ["test", test],
    ] as const) {
      const file = `${name}.v1.${split}.jsonl`;
      const content = jsonl(rows);
      files.set(`evals/datasets/${file}`, content);
      manifestFiles[file] = { sha256: sha256Hex(content), cases: rows.length };
    }
  }
  files.set(
    "evals/datasets/MANIFEST.v1.json",
    canonicalJson({ generator: GENERATOR_VERSION, seed, files: manifestFiles }) + "\n",
  );
  for (const [path, content] of fixtureFiles()) files.set(path, content);
  return files;
}

export function writeAll(root: string, files: Map<string, string>): void {
  for (const [path, content] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && readFileSync(target, "utf8") === content) continue;
    writeFileSync(target, content);
  }
}

export interface Mismatch {
  path: string;
  reason: "missing" | "differs";
}

export function checkAll(root: string, files: Map<string, string>): Mismatch[] {
  const out: Mismatch[] = [];
  for (const [path, content] of files) {
    const target = join(root, path);
    if (!existsSync(target)) out.push({ path, reason: "missing" });
    else if (readFileSync(target, "utf8") !== content) out.push({ path, reason: "differs" });
  }
  return out;
}
