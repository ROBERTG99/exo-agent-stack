import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCommand } from "../../../cli/src/commands/doctor.ts";
import { buildReport, formatReport } from "../../../doctor/src/report.ts";
import { cleanSnapshot } from "../../../data/generator/src/suites/policy.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
const KEY_VAR = ["ANTHROPIC", "API", "KEY"].join("_");

describe("buildReport and formatReport", () => {
  it("counts the statuses and is ok when nothing failed", () => {
    const report = buildReport(cleanSnapshot(), new Date("2026-10-25T10:00:00Z"), 12);
    expect(report).toMatchObject({
      schema: "exos.doctor.v1",
      generated_at: "2026-10-25T10:00:00.000Z",
      duration_ms: 12,
      ok: true,
    });
    expect(report.checks).toHaveLength(22);
    expect(report.counts.fail).toBe(0);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(22);
  });

  it("is not ok when a check failed, and the text names it with its fix", () => {
    const s = cleanSnapshot();
    s.vault.shared = true;
    const report = buildReport(s);
    expect(report.ok).toBe(false);
    const text = formatReport(report);
    expect(text).toMatch(/^FAIL {2}D-07 /m);
    expect(text).toContain("fix: ");
    expect(text).toMatch(/\d+ passed, \d+ warnings, 1 failed, \d+ skipped$/);
  });

  it("prints a fix for warnings but not for passes or skips", () => {
    const s = cleanSnapshot();
    s.unavailable = { "D-06": "needs Exo" };
    const lines = formatReport(buildReport(s)).split("\n");
    const at = (id: string) => lines.findIndex((l) => l.includes(id));
    expect(lines[at("D-01") + 2]).toMatch(/^(PASS|WARN|FAIL|SKIP)/); // a pass has no fix line
    expect(lines[at("D-06") + 1]).toContain("needs Exo");
    expect(lines[at("D-10") + 2]).toContain("fix: "); // a warning does
  });
});

describe("exos doctor", () => {
  function tempRoot(withKey: boolean) {
    const root = mkdtempSync(join(tmpdir(), "doctor-cli-"));
    for (const dir of ["agents", "environments", "pricing"])
      cpSync(join(repo, dir), join(root, dir), { recursive: true });
    if (withKey) writeFileSync(join(root, ".env"), `${KEY_VAR}=x\n`);
    return root;
  }
  const exec = async (args: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await doctorCommand(args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("exits 1 and prints JSON when a check fails", async () => {
    const root = tempRoot(true);
    const r = await exec(["--json", "--root", root], { EXOS_STATE_DIR: join(root, "state") });
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ schema: "exos.doctor.v1", ok: false });
    expect(report.checks.find((c: { id: string }) => c.id === "D-05")).toMatchObject({
      status: "fail",
    });
    expect(r.out).not.toContain("=x");
  });

  it("prints the text report by default and finishes within five seconds", async () => {
    const root = tempRoot(false);
    const started = Date.now();
    const r = await exec(["--root", root], { EXOS_STATE_DIR: join(root, "state") });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.out).toMatch(/^(PASS|WARN|FAIL|SKIP) {2}D-01 /m);
    expect(r.out).toMatch(/\d+ passed, \d+ warnings, \d+ failed, \d+ skipped$/);
    expect(r.code).toBe(/ 0 failed,/.test(r.out) ? 0 : 1);
  });

  it("refuses an argument it does not know", async () => {
    const r = await exec(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown argument --nope");
  });

  it("reports a root it cannot read as a usage error", async () => {
    const r = await exec(["--root", join(tmpdir(), "does-not-exist-" + Date.now())]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("could not read the stack");
  });
});
