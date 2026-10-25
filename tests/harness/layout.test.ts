import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("T-01 bootstrap layout", () => {
  it("has the progress and decision files at the BUILD.md locations", () => {
    for (const p of ["PROGRESS.md", "docs/DECISIONS.md", "docs/DEVELOPMENT.md", ".editorconfig"]) {
      expect(existsSync(join(root, p)), p).toBe(true);
    }
  });

  it("does not use the personal-playbook layout", () => {
    expect(existsSync(join(root, "_meta"))).toBe(false);
    expect(existsSync(join(root, ".claude/commands/retomar.md"))).toBe(false);
  });

  it("keeps a copy of the build spec under docs/specs", () => {
    const copy = join(root, "docs/specs/000-build-spec.md");
    expect(existsSync(copy)).toBe(true);
    // BUILD.md moves into docs/specs at the end of the build (§19.7); until then both are identical.
    if (existsSync(join(root, "BUILD.md"))) {
      expect(read("docs/specs/000-build-spec.md")).toBe(read("BUILD.md"));
    }
  });

  it("PROGRESS.md leads with 'Needs the maintainer' and tracks every task and the DoD", () => {
    const text = read("PROGRESS.md");
    const firstSection = text.split("\n").find((l) => l.startsWith("## "));
    expect(firstSection).toMatch(/Needs the maintainer/i);
    for (let i = 1; i <= 52; i++) {
      const id = `T-${String(i).padStart(2, "0")}`;
      expect(text, id).toContain(id);
    }
    expect(text).toMatch(/Global Definition of Done/);
    expect(text).toMatch(/Model usage/);
    expect(text).toMatch(/Fable invocations/);
  });

  it("seeds the §1.5 maintainer-only items", () => {
    const text = read("PROGRESS.md");
    for (const needle of [
      "claude setup-token",
      "mode-b-store-token.sh",
      "store-cursor-key.sh",
      "Slack app",
      "make live-claude",
      "make live-cursor",
      "make eval-live",
      "tags",
      "Exo pin",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("records the §1.1 attribution evidence in PROGRESS.md", () => {
    const text = read("PROGRESS.md");
    expect(text).toContain("chore: configure commit attribution");
    expect(text).toMatch(/GIT_AUTHOR_IDENT/);
  });

  it("extends .gitignore per §1.2 without ignoring lockfiles", () => {
    const g = read(".gitignore");
    for (const needle of [".env.*", "!.env.example", ".exos-state/", "vendor/exo/target/", "evals/reports/*.json", "!evals/reports/baseline*.json"]) {
      expect(g, needle).toContain(needle);
    }
    expect(g).not.toMatch(/lock/i);
  });

  it("has an editorconfig and an MIT license for ROBERTG99", () => {
    expect(read(".editorconfig")).toMatch(/root\s*=\s*true/);
    expect(read("LICENSE")).toMatch(/Copyright \(c\) 2026 ROBERTG99/);
  });

  it("DEVELOPMENT.md records the detected environment", () => {
    const text = read("docs/DEVELOPMENT.md");
    for (const needle of ["node", "pnpm", "uv", "cargo", "docker", "claude", "/dev/kvm", "Darwin", "arm64"]) {
      expect(text, needle).toContain(needle);
    }
  });
});
