import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const log = readFileSync(join(root, "docs", "exo-verification.md"), "utf8");
const limitations = readFileSync(join(root, "docs", "KNOWN_LIMITATIONS.md"), "utf8");

interface Row {
  id: string;
  item: string;
  where: string;
  status: string;
  evidence: string;
  fallback: string;
}

const rows: Row[] = log
  .split("\n")
  .filter((l) => /^\|\s*V-\d+\s*\|/.test(l))
  .map((l) => {
    const [, id, item, where, status, evidence, fallback] = l.split("|").map((c) => c.trim());
    return {
      id: id!,
      item: item!,
      where: where!,
      status: status!,
      evidence: evidence!,
      fallback: fallback!,
    };
  });

describe("docs/exo-verification.md (BUILD.md §0.1 rail 8, T-09)", () => {
  it("covers V-1 to V-11 of the spec, plus the items found while building", () => {
    const ids = rows.map((r) => r.id);
    for (let i = 1; i <= 11; i++) expect(ids, `V-${i}`).toContain(`V-${i}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(16);
  });

  it("gives every item a status of verified, unverified or contradicted", () => {
    for (const r of rows)
      expect(["verified", "unverified", "contradicted"], r.id).toContain(r.status);
  });

  it("never marks an item verified without a file:line in the pinned source", () => {
    for (const r of rows.filter((x) => x.status === "verified")) {
      expect(r.evidence, r.id).toMatch(/vendor\/exo\/\S+:\d+/);
    }
  });

  it("states, for every item that is not verified, the fallback in use and where to look", () => {
    for (const r of rows.filter((x) => x.status !== "verified")) {
      expect(r.fallback.length, `${r.id} fallback`).toBeGreaterThan(15);
      expect(r.where.length, `${r.id} where`).toBeGreaterThan(5);
    }
  });

  it("is honest about the pin: it says the source was not available", () => {
    expect(log).toMatch(/vendor\/exo.*not (checked out|available)/is);
    expect(log).toContain("f9f012730fd3bf7e061e3e947e01bd6c2bb415e9");
    expect(log).toMatch(/docs\/KNOWN_LIMITATIONS\.md/);
  });

  it("every item is also named in docs/KNOWN_LIMITATIONS.md, where its fallback is recorded", () => {
    for (const r of rows) expect(limitations, r.id).toMatch(new RegExp(`\\b${r.id}\\b`));
  });

  it("records the Claude Code facts that were checked locally, each with its command", () => {
    expect(log).toMatch(/permission-prompt-tool/);
    expect(log).toMatch(/grep -a -c/);
    expect(log).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(log).toMatch(/2\.1\.212/);
  });
});
