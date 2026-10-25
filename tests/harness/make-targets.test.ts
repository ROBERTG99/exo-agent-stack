import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const spec = readFileSync(join(root, "docs/specs/000-build-spec.md"), "utf8");
const makefile = readFileSync(join(root, "Makefile"), "utf8");

/** Every `make <target>` named in the two §16 tables of the build spec. */
function specTargets(): string[] {
  const section = spec.slice(spec.indexOf("## 16. Docker"), spec.indexOf("## 17. CI/CD"));
  const targets = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `make ")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const m of firstCell.matchAll(/`make ([a-z][a-z0-9-]*)`/g)) targets.add(m[1]!);
  }
  return [...targets].sort();
}

describe("T-03 Makefile targets", () => {
  const targets = specTargets();

  it("parses the spec tables (guards the parser itself)", () => {
    expect(targets.length).toBeGreaterThanOrEqual(35);
    for (const t of [
      "bootstrap",
      "up",
      "verify",
      "doctor",
      "exo-build",
      "live-claude",
      "plugin-validate",
    ]) {
      expect(targets, t).toContain(t);
    }
  });

  it.each(targets)("defines and declares %s as phony", (t) => {
    expect(makefile).toMatch(new RegExp(`^${t}:`, "m"));
    const phony = makefile.match(/^\.PHONY:([^\n]*(?:\\\n[^\n]*)*)/gm)?.join(" ") ?? "";
    expect(phony.replace(/\\\n/g, " ").split(/\s+/)).toContain(t);
  });

  it.each(targets)("make -n %s parses without error", (t) => {
    const r = spawnSync("make", ["-n", t], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "" },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("is compatible with GNU Make 3.81 (macOS default): no .ONESHELL, no $(file ...)", () => {
    expect(makefile).not.toMatch(/\.ONESHELL/);
    expect(makefile).not.toMatch(/\$\(file /);
  });

  it("exposes help", () => {
    const out = execFileSync("make", ["help"], { cwd: root, encoding: "utf8" });
    expect(out).toContain("check-fast");
  });
});
