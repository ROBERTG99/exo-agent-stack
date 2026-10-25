// FR-13: given the 25 seeded misconfigurations each fails its own check, given 10 clean stacks none fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stackSnapshotSchema, type StackSnapshot } from "@exos/common";
import { runChecks } from "../../../doctor/src/checks/index.ts";

const root = join(import.meta.dirname, "..", "..", "..");

interface Row {
  id: string;
  kind: "misconfig" | "clean";
  description: string;
  expect_fail: string[];
  snapshot: StackSnapshot;
}

const rows: Row[] = ["dev", "test"].flatMap((split) =>
  readFileSync(join(root, `evals/datasets/policy.v1.${split}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row),
);

const failed = (s: StackSnapshot) =>
  runChecks(s)
    .filter((r) => r.status === "fail")
    .map((r) => r.id)
    .sort();

describe("the seeded policy dataset", () => {
  it("has 25 misconfigurations and 10 clean stacks, all valid snapshots", () => {
    expect(rows.filter((r) => r.kind === "misconfig")).toHaveLength(25);
    expect(rows.filter((r) => r.kind === "clean")).toHaveLength(10);
    for (const r of rows)
      expect(stackSnapshotSchema.safeParse(r.snapshot).success, r.id).toBe(true);
  });

  it.each(rows.filter((r) => r.kind === "misconfig").map((r) => [r.id, r] as const))(
    "%s fails exactly the check it seeds",
    (_id, r) => {
      expect(failed(r.snapshot), r.description).toEqual([...r.expect_fail].sort());
    },
  );

  it.each(rows.filter((r) => r.kind === "clean").map((r) => [r.id, r] as const))(
    "%s (a clean stack) fails nothing",
    (_id, r) => {
      expect(failed(r.snapshot)).toEqual([]);
    },
  );

  it("covers every check at least once among the seeded failures, except those that only warn", () => {
    const seeded = new Set(rows.flatMap((r) => r.expect_fail));
    const warnOnly = new Set(["D-13", "D-14", "D-15", "D-16", "D-18"]);
    const all = runChecks(rows[0]!.snapshot).map((r) => r.id);
    expect(all).toHaveLength(22);
    expect(all.filter((id) => !seeded.has(id) && !warnOnly.has(id))).toEqual([]);
  });
});
