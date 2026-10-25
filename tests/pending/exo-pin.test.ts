import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
// FR-1: the pinned Exo commit (BUILD.md §3.1). A different pin must be recorded in docs/DECISIONS.md.
export const EXO_PIN = "f9f012730fd3bf7e061e3e947e01bd6c2bb415e9";

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

describe("T-02 Exo submodule pin [FR-1]", () => {
  it("registers vendor/exo as a submodule in .gitmodules", () => {
    const text = readFileSync(join(root, ".gitmodules"), "utf8");
    expect(text).toContain("path = vendor/exo");
    expect(text).toMatch(/url = https:\/\/github\.com\/exoharness\/exo(\.git)?/);
  });

  it("pins the gitlink to the specified commit", () => {
    const entry = git("ls-tree", "HEAD", "vendor/exo");
    expect(entry).toMatch(/^160000 commit /);
    expect(entry).toContain(EXO_PIN);
  });

  it("has the pinned sources checked out (when the submodule is initialised)", () => {
    const dir = join(root, "vendor/exo");
    if (!existsSync(join(dir, ".git"))) return; // fresh clone without --recurse-submodules
    expect(git("-C", "vendor/exo", "rev-parse", "HEAD")).toBe(EXO_PIN);
  });

  it("never edits upstream: the submodule has no local modifications", () => {
    const dir = join(root, "vendor/exo");
    if (!existsSync(join(dir, ".git"))) return;
    expect(git("-C", "vendor/exo", "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("ships an executable exo-build script that runs the §1.3 commands", () => {
    const p = join(root, "scripts/exo-build.sh");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o111).not.toBe(0);
    const text = readFileSync(p, "utf8");
    expect(text).toContain("pnpm install --frozen-lockfile");
    expect(text).toContain("cargo build -p exo --release");
  });
});
