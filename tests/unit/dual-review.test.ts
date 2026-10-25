import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparisonSchema,
  compareReviews,
  parseFindings,
  type Finding,
  type Side,
} from "../../cli/src/commands/dual-review.ts";

const root = join(import.meta.dirname, "..", "..");
const recordings = join(root, "fixtures", "exo-recordings", "dual-review");
const f = (file: string, line: number, category: string, summary = "s"): Finding => ({
  file,
  line,
  category,
  summary,
});

describe("parseFindings", () => {
  it("reads Markdown bullet findings", () => {
    const { findings, warnings } = parseFindings(
      [
        "# Review",
        "Some prose that is not a finding.",
        "## Findings",
        "- [correctness] src/a.ts:3 loop bound reads one past the end",
        "* [Security] ./src/db.ts:2 - SQL built by concatenation",
        "1. [error-handling] b/src/client.ts:5: error swallowed",
        "- [concurrency] src/counter.ts:4-6 read-modify-write across an await",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(findings).toEqual([
      f("src/a.ts", 3, "correctness", "loop bound reads one past the end"),
      f("src/db.ts", 2, "security", "SQL built by concatenation"),
      f("src/client.ts", 5, "error-handling", "error swallowed"),
      f("src/counter.ts", 4, "concurrency", "read-modify-write across an await"),
    ]);
  });

  it("reads JSON lines and reports lines it cannot use", () => {
    const text = [
      JSON.stringify({ file: "src/a.ts", line: 3, category: "correctness", summary: "x" }),
      "not a finding at all {",
      JSON.stringify({ file: "src/b.ts", line: "7", category: "Security", summary: "y" }),
      JSON.stringify({ file: "src/c.ts", category: "security" }),
    ].join("\n");
    const { findings, warnings } = parseFindings(text);
    expect(findings.map((x) => `${x.file}:${x.line}:${x.category}`)).toEqual([
      "src/a.ts:3:correctness",
      "src/b.ts:7:security",
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/line 2/);
    expect(warnings.join(" ")).toMatch(/line 4/);
  });

  it("merges duplicates (same file, line and category) and ignores bullets that are not findings", () => {
    const { findings } = parseFindings(
      [
        "- [correctness] a.ts:1 first",
        "- [correctness] a.ts:1 same place again",
        "- just a bullet",
        "- [x] not:a:finding",
      ].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toBe("first");
  });

  it("returns nothing for an empty report", () => {
    expect(parseFindings("")).toEqual({ findings: [], warnings: [] });
  });
});

describe("compareReviews (dual-review.comparison.v1)", () => {
  const a = [
    f("src/a.ts", 3, "correctness"),
    f("src/db.ts", 2, "security"),
    f("src/only-a.ts", 9, "concurrency"),
  ];
  const b = [
    f("src/a.ts", 3, "correctness"),
    f("src/db.ts", 4, "security"),
    f("src/only-b.ts", 1, "correctness"),
  ];

  it("lists findings per side, the overlap and what only one side found", () => {
    const c = compareReviews({ label: "claude", findings: a }, { label: "cursor", findings: b });
    expect(c.schema).toBe("dual-review.comparison.v1");
    expect(c.sides.a).toMatchObject({ label: "claude", count: 3 });
    expect(c.sides.b).toMatchObject({ label: "cursor", count: 3 });
    expect(c.overlap.map((o) => `${o.a.file}:${o.a.line}~${o.b.line}:${o.match}`)).toEqual([
      "src/a.ts:3~3:exact",
      "src/db.ts:2~4:near",
    ]);
    expect(c.only_a.map((x) => x.file)).toEqual(["src/only-a.ts"]);
    expect(c.only_b.map((x) => x.file)).toEqual(["src/only-b.ts"]);
    expect(c.summary).toEqual({
      a: 3,
      b: 3,
      overlap: 2,
      only_a: 1,
      only_b: 1,
      jaccard: 0.5,
      tolerance: 3,
    });
  });

  it("does not match across files or categories, or beyond the line tolerance", () => {
    const c = compareReviews(
      {
        label: "a",
        findings: [
          f("x.ts", 10, "security"),
          f("y.ts", 1, "correctness"),
          f("z.ts", 1, "correctness"),
        ],
      },
      {
        label: "b",
        findings: [
          f("x.ts", 10, "correctness"),
          f("w.ts", 1, "correctness"),
          f("z.ts", 5, "correctness"),
        ],
      },
    );
    expect(c.overlap).toHaveLength(0);
    expect(c.summary).toMatchObject({ overlap: 0, jaccard: 0 });
  });

  it("honours a custom tolerance", () => {
    const left: Side = { label: "a", findings: [f("z.ts", 1, "correctness")] };
    const right: Side = { label: "b", findings: [f("z.ts", 5, "correctness")] };
    expect(compareReviews(left, right).overlap).toHaveLength(0);
    expect(compareReviews(left, right, { tolerance: 4 }).overlap).toHaveLength(1);
    expect(compareReviews(left, right, { tolerance: 0 }).overlap).toHaveLength(0);
  });

  it("matches one-to-one, preferring the closest line", () => {
    const c = compareReviews(
      { label: "a", findings: [f("z.ts", 10, "security"), f("z.ts", 12, "security")] },
      { label: "b", findings: [f("z.ts", 11, "security")] },
    );
    expect(c.overlap).toHaveLength(1);
    expect(c.only_a).toHaveLength(1);
    expect(c.only_b).toHaveLength(0);
    // 10 and 12 are both at distance 1; the earlier finding on side a wins, deterministically.
    expect(c.overlap[0]!.a.line).toBe(10);
  });

  it("is deterministic and independent of input order", () => {
    const one = compareReviews({ label: "a", findings: a }, { label: "b", findings: b });
    const two = compareReviews(
      { label: "a", findings: [...a].reverse() },
      { label: "b", findings: [...b].reverse() },
    );
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it("treats two empty reviews as full agreement and one empty side as no overlap", () => {
    expect(
      compareReviews({ label: "a", findings: [] }, { label: "b", findings: [] }).summary.jaccard,
    ).toBe(1);
    const c = compareReviews({ label: "a", findings: a }, { label: "b", findings: [] });
    expect(c.summary).toMatchObject({ overlap: 0, only_a: 3, only_b: 0, jaccard: 0 });
  });

  it("validates against its own published schema", () => {
    const c = compareReviews({ label: "a", findings: a }, { label: "b", findings: b });
    expect(comparisonSchema.safeParse(c).success).toBe(true);
    expect(comparisonSchema.safeParse({ ...c, schema: "dual-review.comparison.v2" }).success).toBe(
      false,
    );
  });
});

describe("the two recorded review streams", () => {
  const claude = parseFindings(readFileSync(join(recordings, "claude.review.md"), "utf8"));
  const cursor = parseFindings(readFileSync(join(recordings, "cursor.review.md"), "utf8"));

  it("parse without warnings", () => {
    expect(claude.warnings).toEqual([]);
    expect(cursor.warnings).toEqual([]);
    expect(claude.findings.length).toBeGreaterThanOrEqual(3);
    expect(cursor.findings.length).toBeGreaterThanOrEqual(3);
  });

  it("compare into a result with an overlap and findings only one side made", () => {
    const c = compareReviews(
      { label: "claude", findings: claude.findings },
      { label: "cursor", findings: cursor.findings },
    );
    expect(c.summary.overlap).toBeGreaterThanOrEqual(2);
    expect(c.summary.only_a).toBeGreaterThanOrEqual(1);
    expect(c.summary.only_b).toBeGreaterThanOrEqual(1);
    expect(comparisonSchema.safeParse(c).success).toBe(true);
  });
});

describe("exos dual-review compare", () => {
  const cli = join(root, "cli", "src", "main.ts");
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "dual-review", ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  it("prints the comparison JSON for two recorded reviews", () => {
    const r = run([
      "compare",
      "--a",
      join(recordings, "claude.review.md"),
      "--b",
      join(recordings, "cursor.review.md"),
      "--label-a",
      "claude",
      "--label-b",
      "cursor",
    ]);
    expect(r.status, r.err).toBe(0);
    const c = JSON.parse(r.out);
    expect(c.schema).toBe("dual-review.comparison.v1");
    expect(c.sides.a.label).toBe("claude");
    expect(comparisonSchema.safeParse(c).success).toBe(true);
  });

  it("writes --out and prints a one-line summary", () => {
    const out = join(mkdtempSync(join(tmpdir(), "dr-")), "cmp.json");
    const r = run([
      "compare",
      "--a",
      join(recordings, "claude.review.md"),
      "--b",
      join(recordings, "cursor.review.md"),
      "--out",
      out,
    ]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/overlap \d+ of \d+ and \d+/);
    expect(comparisonSchema.safeParse(JSON.parse(readFileSync(out, "utf8"))).success).toBe(true);
  });

  it("accepts a custom tolerance", () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-"));
    writeFileSync(join(dir, "a.md"), "- [correctness] z.ts:1 one\n");
    writeFileSync(join(dir, "b.md"), "- [correctness] z.ts:5 one\n");
    expect(
      JSON.parse(run(["compare", "--a", join(dir, "a.md"), "--b", join(dir, "b.md")]).out).summary
        .overlap,
    ).toBe(0);
    expect(
      JSON.parse(
        run(["compare", "--a", join(dir, "a.md"), "--b", join(dir, "b.md"), "--tolerance", "4"])
          .out,
      ).summary.overlap,
    ).toBe(1);
  });

  it.each([
    ["no subcommand", []],
    ["an unknown subcommand", ["diff"]],
    ["a missing --b", ["compare", "--a", "x"]],
    [
      "a file that does not exist",
      ["compare", "--a", "/nonexistent/a.md", "--b", "/nonexistent/b.md"],
    ],
    ["a non-numeric tolerance", ["compare", "--a", "x", "--b", "y", "--tolerance", "many"]],
  ])("exits 2 for %s", (_n, args) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/usage|not found|cannot read|invalid/i);
  });
});
