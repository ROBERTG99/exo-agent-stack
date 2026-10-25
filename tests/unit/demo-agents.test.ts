import { describe, expect, it } from "vitest";
import { renderAgents, resolveToken } from "../../scripts/demo.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("demo: list agents", () => {
  it("renders a table with slug and harness", () => {
    const out = renderAgents([
      { id: "a1", slug: "repo-builder", name: "repo-builder", harness: "claude-host" },
      { id: "a2", slug: "reviewer-cursor", harness: "cursor" },
    ]);
    expect(out).toContain("SLUG");
    expect(out).toMatch(/repo-builder\s+claude-host/);
    expect(out).toMatch(/reviewer-cursor\s+cursor/);
  });

  it("falls back to id/name when slug or harness are missing", () => {
    const out = renderAgents([{ id: "only-id" }]);
    expect(out).toContain("only-id");
    expect(out).toContain("-");
  });

  it("says so when there are no agents", () => {
    expect(renderAgents([])).toMatch(/no agents/i);
  });

  it("reads the token from EXOS_LOCAL_TOKEN first, then the state dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-"));
    writeFileSync(join(dir, "local-token"), "filetoken\n");
    expect(resolveToken({ EXOS_LOCAL_TOKEN: "envtoken" }, dir)).toBe("envtoken");
    expect(resolveToken({}, dir)).toBe("filetoken");
    expect(() => resolveToken({}, join(dir, "missing"))).toThrow(/token/i);
  });
});
