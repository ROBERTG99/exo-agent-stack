import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const envExample = readFileSync(join(root, ".env.example"), "utf8");

const declared = new Map<string, string>();
for (const line of envExample.split("\n")) {
  const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) declared.set(m[1]!, m[2]!);
}

/** Source and config files (tracked or untracked-but-not-ignored) that may reference EXOS_ variables. */
function scannedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((f) => f && existsSync(join(root, f)))
    .filter(
      (f) =>
        !f.startsWith("vendor/") &&
        !f.startsWith("docs/") &&
        f !== "BUILD.md" &&
        f !== "START.md" &&
        f !== "README.md",
    )
    .filter((f) => f !== "PROGRESS.md" && f !== "pnpm-lock.yaml" && !f.endsWith(".md"))
    .filter((f) => f !== ".env.example" && f !== "tests/harness/env-example.test.ts")
    .filter(
      (f) =>
        /\.(ts|tsx|mjs|js|sh|ya?ml|json|toml|mdc?)$|^Makefile$|\.env/.test(f) ||
        f.startsWith(".claude/hooks/"),
    );
}

describe("T-03 .env.example", () => {
  it("lists every EXOS_ variable referenced by code or config", () => {
    const missing = new Set<string>();
    for (const f of scannedFiles()) {
      const text = readFileSync(join(root, f), "utf8");
      for (const m of text.matchAll(/\bEXOS_[A-Z0-9_]*[A-Z0-9]\b/g)) {
        if (!declared.has(m[0])) missing.add(`${m[0]} (${f})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("declares the spec'd budget, credit and limit variables with the spec defaults", () => {
    const expectDefault: Record<string, string> = {
      EXOS_MONTHLY_CREDIT_USD: "20",
      EXOS_CURSOR_MONTHLY_BUDGET_USD: "20",
      EXOS_CREDIT_CYCLE_DAY: "1",
      EXOS_CREDIT_TZ: "UTC",
      EXOS_CREDIT_WARN_RATIO: "0.70",
      EXOS_CREDIT_STOP_RATIO: "0.95",
      EXOS_CREDIT_CANCEL_ACTIVE: "false",
      EXOS_METER_INTERVAL_SECONDS: "15",
      EXOS_MAX_ACTIVE_TURNS: "4",
      EXOS_RECOVERY_MAX_ATTEMPTS: "3",
      LIVE_EVAL_BUDGET_USD: "2",
    };
    for (const [k, v] of Object.entries(expectDefault)) expect(declared.get(k), k).toBe(v);
  });

  it("holds no credential: no API-key variables, no key-shaped literals, empty token", () => {
    for (const forbidden of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]) {
      expect(envExample, forbidden).not.toContain(forbidden);
    }
    expect(envExample).not.toMatch(/sk-ant-|sk-proj-|sk-or-v1-/);
    expect(declared.get("EXOS_LOCAL_TOKEN")).toBe("");
    // The live guard must never be pre-confirmed in an example file.
    expect(declared.get("EXOS_LIVE_CONFIRM") ?? "").toBe("");
  });

  it("never binds beyond loopback", () => {
    expect(envExample).not.toContain("0.0.0.0");
    for (const [k, v] of declared) {
      if (/_URL$|_BIND$/.test(k) && v) expect(v, k).toMatch(/127\.0\.0\.1|localhost/);
    }
  });
});
