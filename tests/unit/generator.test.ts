/* eslint-disable @typescript-eslint/no-explicit-any -- dataset rows are schemaless JSON in these assertions */
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, stackSnapshotSchema } from "@exos/common";
import {
  GENERATOR_VERSION,
  SEED,
  checkAll,
  cleanSnapshot,
  generateAll,
  writeAll,
} from "@exos/generator";

const files = generateAll();
const lines = (path: string): Record<string, any>[] =>
  files
    .get(path)!
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const both = (suite: string) => [
  ...lines(`evals/datasets/${suite}.v1.dev.jsonl`),
  ...lines(`evals/datasets/${suite}.v1.test.jsonl`),
];

describe("determinism (seed 20261022, gen.v1)", () => {
  it("uses the specified seed and version", () => {
    expect(SEED).toBe(20261022);
    expect(GENERATOR_VERSION).toBe("gen.v1");
  });

  it("produces byte-identical output on every run", () => {
    const again = generateAll();
    expect([...again.keys()]).toEqual([...files.keys()]);
    for (const [path, content] of files) expect(again.get(path), path).toBe(content);
  });

  it("changes when the seed changes", () => {
    const other = generateAll({ seed: SEED + 1 });
    expect(other.get("evals/datasets/durability.v1.test.jsonl")).not.toBe(
      files.get("evals/datasets/durability.v1.test.jsonl"),
    );
  });

  it("never reads a clock or unseeded randomness", () => {
    const dir = join(import.meta.dirname, "..", "..", "data", "generator", "src");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    for (const f of walk(dir)) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/Math\.random|Date\.now|new Date\(\)|performance\.now/);
    }
  });
});

describe("dataset sizes and splits (BUILD.md §11)", () => {
  it.each([
    ["durability", 30, 10, 20],
    ["delegation", 20, 6, 14],
    ["policy", 35, 8, 27],
    ["credit", 24, 8, 16],
    ["dual-review", 10, 3, 7],
  ])("%s has %i cases (%i dev / %i test)", (suite, total, dev, test) => {
    expect(lines(`evals/datasets/${suite}.v1.dev.jsonl`)).toHaveLength(dev);
    expect(lines(`evals/datasets/${suite}.v1.test.jsonl`)).toHaveLength(test);
    const cases = both(suite);
    expect(cases).toHaveLength(total);
    expect(new Set(cases.map((c) => c.id)).size).toBe(total);
    for (const c of cases) {
      expect(c.suite).toBe(suite);
      expect(["dev", "test"]).toContain(c.split);
    }
    for (const c of lines(`evals/datasets/${suite}.v1.dev.jsonl`)) expect(c.split).toBe("dev");
    for (const c of lines(`evals/datasets/${suite}.v1.test.jsonl`)) expect(c.split).toBe("test");
  });

  it("writes canonical JSON lines (sorted keys, one case per line, trailing newline)", () => {
    const raw = files.get("evals/datasets/credit.v1.dev.jsonl")!;
    expect(raw.endsWith("\n")).toBe(true);
    for (const l of raw.trim().split("\n")) {
      const obj = JSON.parse(l);
      expect(l).toBe(JSON.stringify(sortKeys(obj)));
    }
  });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as object)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

describe("durability suite", () => {
  const cases = both("durability");
  it("kills Exo strictly inside the run", () => {
    for (const c of cases) {
      expect(c.total_steps).toBeGreaterThanOrEqual(8);
      expect(c.kill_at_step).toBeGreaterThanOrEqual(2);
      expect(c.kill_at_step).toBeLessThanOrEqual(c.total_steps - 2);
      expect(typeof c.drop_client).toBe("boolean");
      expect(typeof c.restart_stackd).toBe("boolean");
      expect(c.expect).toEqual({
        completed: true,
        duplicates: 0,
        unique_ledger_entries: c.total_steps,
      });
    }
  });

  it("includes the headline case: 12 steps, killed at step 6", () => {
    expect(cases.some((c) => c.total_steps === 12 && c.kill_at_step === 6)).toBe(true);
  });

  it("varies the failure mode across cases", () => {
    expect(new Set(cases.map((c) => `${c.drop_client}/${c.restart_stackd}`)).size).toBe(4);
  });
});

describe("delegation suite", () => {
  const cases = both("delegation");
  const errors = new Set([
    "invalid_input",
    "not_found",
    "ambiguous_thread",
    "turn_active",
    "credit_stop",
    "dashboard_only",
    "fork_at_unsupported",
    "idempotency_conflict",
    "exo_unavailable",
    "workspace_not_allowed",
    "rate_limited",
  ]);

  it("replay and conflict ops point at an earlier op that carries a key", () => {
    for (const c of cases) {
      c.ops.forEach((op: any, i: number) => {
        if (op.op === "replay" || op.op === "conflict") {
          expect(op.of, c.id).toBeLessThan(i);
          expect(c.ops[op.of].key, c.id).toBeTruthy();
        }
      });
    }
  });

  it("every expectation is a success or one of the documented bridge errors", () => {
    for (const c of cases) {
      expect(c.ops.length).toBeGreaterThan(0);
      for (const op of c.ops) {
        expect(op.expect).toBeDefined();
        if (op.expect.error)
          expect(errors.has(op.expect.error), `${c.id}: ${op.expect.error}`).toBe(true);
        else expect(op.expect.ok).toBe(true);
      }
    }
  });

  it("covers start, replay, conflict, approve, dashboard-only, answer, fork and credit stop", () => {
    const seen = new Set(cases.flatMap((c) => c.ops.map((o: any) => o.expect.error ?? o.op)));
    for (const needle of [
      "start",
      "replay",
      "idempotency_conflict",
      "approve",
      "dashboard_only",
      "answer",
      "fork",
      "credit_stop",
      "turn_active",
      "workspace_not_allowed",
    ]) {
      expect(seen.has(needle), needle).toBe(true);
    }
  });

  it("marks replays as replayed:true and keeps prompts within the 20,000 character limit unless testing it", () => {
    for (const c of cases) {
      for (const op of c.ops) {
        if (op.op === "replay") expect(op.expect).toMatchObject({ ok: true, replayed: true });
        if (op.prompt && op.expect.error !== "invalid_input")
          expect(op.prompt.length).toBeLessThanOrEqual(20000);
      }
    }
  });
});

describe("policy suite", () => {
  const cases = both("policy");
  const misconfigs = cases.filter((c) => c.expect_fail.length > 0);
  const clean = cases.filter((c) => c.expect_fail.length === 0);

  it("has 25 seeded misconfigurations and 10 clean stacks", () => {
    expect(misconfigs).toHaveLength(25);
    expect(clean).toHaveLength(10);
  });

  it("every snapshot satisfies the StackSnapshot schema", () => {
    for (const c of cases) {
      const r = stackSnapshotSchema.safeParse(c.snapshot);
      expect(r.success, `${c.id}: ${r.success ? "" : JSON.stringify(r.error.issues[0])}`).toBe(
        true,
      );
    }
  });

  it("each misconfiguration expects exactly one failing check, and the set covers 17 checks", () => {
    for (const c of misconfigs) expect(c.expect_fail, c.id).toHaveLength(1);
    const checks = new Set(misconfigs.map((c) => c.expect_fail[0]));
    expect([...checks].sort()).toEqual(
      [
        "D-01",
        "D-02",
        "D-03",
        "D-04",
        "D-05",
        "D-06",
        "D-07",
        "D-08",
        "D-09",
        "D-10",
        "D-11",
        "D-12",
        "D-17",
        "D-19",
        "D-20",
        "D-21",
        "D-22",
      ].sort(),
    );
  });

  it("clean stacks differ from each other", () => {
    expect(new Set(clean.map((c) => JSON.stringify(c.snapshot))).size).toBe(10);
  });

  it("a misconfiguration really differs from the exact clean baseline, in exactly one section", () => {
    // Regression: a mutation that filtered on a corrupted rule name was a silent no-op while the
    // old check (compared with a clean *variant*) still passed.
    const base = cleanSnapshot() as Record<string, unknown>;
    for (const c of misconfigs) {
      const snap = c.snapshot as Record<string, unknown>;
      const changed = Object.keys(base).filter(
        (k) => canonicalJson(snap[k]) !== canonicalJson(base[k]),
      );
      expect(changed, `${c.id} ${c.description}`).toHaveLength(1);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it("only the D-12 'missing rule' case lacks the rm deny rule; every other stack has it, spelled literally", () => {
    const rule = "Bash(rm -rf:*)";
    for (const c of cases) {
      const has = (c.snapshot as any).mode_a.deny_list.includes(rule);
      const isMissingRuleCase = c.description === "Mode A deny list lacks the rm -rf rule";
      expect(has, c.id).toBe(!isMissingRuleCase);
    }
    expect(JSON.stringify(cases)).not.toMatch(/trash/i);
  });

  it("holds names only: no key-shaped values anywhere", () => {
    const text = JSON.stringify(cases);
    expect(text).not.toMatch(new RegExp(["sk-ant-", "sk-" + "proj-", "sk-" + "or-v1-"].join("|")));
  });

  it("uses only reserved example domains and loopback addresses", () => {
    const text = JSON.stringify(cases);
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)) {
      const host = m[1]!;
      const ok =
        host === "127.0.0.1" ||
        host === "localhost" ||
        host.endsWith("example.org") ||
        host.endsWith("example.com") ||
        host.endsWith(".invalid") ||
        // The real provider hosts the allowlists legitimately name.
        [
          "api.anthropic.com",
          "mcp.deepwiki.com",
          "api.openai.com",
          "openrouter.ai",
          "api.github.com",
        ].includes(host);
      expect(ok, host).toBe(true);
    }
  });
});

describe("credit suite", () => {
  const cases = both("credit");

  // An independent oracle: integer arithmetic only (BUILD.md §4.8).
  function oracle(c: any) {
    const budget: Record<string, bigint> = {};
    for (const [pool, v] of Object.entries(c.config.budget_micros))
      budget[pool] = BigInt(v as number);
    const spent = new Map<string, bigint>();
    const cycleOf = (ts: string) => {
      const d = new Date(ts);
      let y = d.getUTCFullYear();
      let m = d.getUTCMonth() + 1;
      if (d.getUTCDate() < c.config.cycle_day) {
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
      return `${y}-${String(m).padStart(2, "0")}`;
    };
    return c.steps.map((s: any) => {
      const cycle = cycleOf(s.ts);
      if (s.type === "budget") budget[s.pool] = BigInt(s.budget_micros);
      const key = `${cycle}|${s.pool}`;
      if (s.type === "usage") spent.set(key, (spent.get(key) ?? 0n) + BigInt(s.micros));
      const S = spent.get(key) ?? 0n;
      const B = budget[s.pool]!;
      const state =
        S * 10000n >= B * BigInt(c.config.stop_bp)
          ? "stop"
          : S * 10000n >= B * BigInt(c.config.warn_bp)
            ? "warn"
            : "ok";
      return { cycle, pool: s.pool, spent_micros: Number(S), budget_micros: Number(B), state };
    });
  }

  it("gold labels match an independent integer oracle", () => {
    for (const c of cases) expect(c.expect, c.id).toEqual(oracle(c));
  });

  it("has one expectation per step and non-decreasing timestamps", () => {
    for (const c of cases) {
      expect(c.expect).toHaveLength(c.steps.length);
      const ts = c.steps.map((s: any) => Date.parse(s.ts));
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    }
  });

  it("exercises the exact thresholds: 70% -> warn at exactly 14.00 of 20, one micro below stays ok", () => {
    const exact = cases.find((c) => c.kind === "exact-warn")!;
    const states = exact.expect.map((e: any) => `${e.spent_micros}:${e.state}`);
    expect(states).toContain("13999999:ok");
    expect(states.some((s: string) => /^14000000:warn$/.test(s) || s.endsWith(":warn"))).toBe(true);
    const stop = cases.find((c) => c.kind === "exact-stop")!;
    expect(
      stop.expect.some(
        (e: any) => e.spent_micros * 100 === e.budget_micros * 95 && e.state === "stop",
      ),
    ).toBe(true);
    expect(
      stop.expect.some(
        (e: any) => e.spent_micros * 100 === e.budget_micros * 95 - 100 && e.state === "warn",
      ),
    ).toBe(true);
  });

  it("covers rollover, budget changes, cycle day, multiple pools and zero cost", () => {
    const kinds = new Set(cases.map((c) => c.kind));
    for (const k of [
      "exact-warn",
      "exact-stop",
      "rollover",
      "budget-raise",
      "multi-pool",
      "cycle-day",
      "zero-cost",
      "monotonic",
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it("a rollover starts the new cycle from zero", () => {
    const c = cases.find((x) => x.kind === "rollover")!;
    const cycles = new Set(c.expect.map((e: any) => e.cycle));
    expect(cycles.size).toBe(2);
    const first = c.expect.find((e: any) => e.cycle === [...cycles][1]);
    expect(first.state).toBe("ok");
  });
});

describe("dual-review suite", () => {
  const cases = both("dual-review");
  it("each case is a unified diff with gold findings that point inside it", () => {
    for (const c of cases) {
      expect(c.diff).toMatch(/^--- a\//m);
      expect(c.diff).toMatch(/^\+\+\+ b\//m);
      expect(c.diff).toMatch(/^@@ /m);
      expect(c.gold_findings.length).toBeGreaterThan(0);
      for (const f of c.gold_findings) {
        expect(c.diff, c.id).toContain(f.file);
        expect(["correctness", "security", "error-handling", "concurrency"]).toContain(f.category);
        expect(f.line).toBeGreaterThan(0);
      }
    }
  });
});

describe("fixtures", () => {
  it("writes a synthetic review target and build templates", () => {
    const paths = [...files.keys()];
    expect(
      paths.filter((p) => p.startsWith("fixtures/review-target/")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      paths.filter((p) => p.startsWith("fixtures/build-templates/")).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("states the data is synthetic", () => {
    expect(files.get("fixtures/review-target/README.md")).toMatch(/synthetic/i);
  });
});

describe("manifest", () => {
  const manifest = JSON.parse(files.get("evals/datasets/MANIFEST.v1.json")!);
  it("records seed, version and a correct sha256 for every dataset file", () => {
    expect(manifest.generator).toBe("gen.v1");
    expect(manifest.seed).toBe(20261022);
    const datasetFiles = [...files.keys()].filter((p) => /evals\/datasets\/.*\.jsonl$/.test(p));
    expect(Object.keys(manifest.files).sort()).toEqual(
      datasetFiles.map((p) => p.split("/").pop()!).sort(),
    );
    for (const p of datasetFiles) {
      const name = p.split("/").pop()!;
      expect(manifest.files[name].sha256).toBe(sha256Hex(files.get(p)!));
      expect(manifest.files[name].cases).toBe(files.get(p)!.trim().split("\n").length);
    }
  });
});

describe("writeAll and checkAll", () => {
  it("round-trips, and reports a changed file and a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-"));
    writeAll(dir, files);
    expect(checkAll(dir, files)).toEqual([]);
    writeFileSync(join(dir, "evals/datasets/credit.v1.test.jsonl"), "{}\n");
    expect(checkAll(dir, files)).toEqual([
      { path: "evals/datasets/credit.v1.test.jsonl", reason: "differs" },
    ]);
    const dir2 = mkdtempSync(join(tmpdir(), "gen-"));
    expect(checkAll(dir2, files)[0]).toMatchObject({ reason: "missing" });
  });

  it("writing twice leaves the bytes unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-"));
    writeAll(dir, files);
    const before = readFileSync(join(dir, "evals/datasets/policy.v1.test.jsonl"), "utf8");
    writeAll(dir, generateAll());
    expect(readFileSync(join(dir, "evals/datasets/policy.v1.test.jsonl"), "utf8")).toBe(before);
  });
});

describe("checked-in files", () => {
  it("match a fresh regeneration (run `make seed` after changing the generator, and add a new dataset version rather than editing a test split)", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    expect(checkAll(repoRoot, files)).toEqual([]);
  });
});
