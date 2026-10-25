// The doctor's report: counts, the checks, and a plain-text rendering for a terminal.
import type { StackSnapshot } from "@exos/common";
import { runChecks, type CheckResult, type Status } from "./checks/index.ts";

export interface DoctorReport {
  schema: "exos.doctor.v1";
  generated_at: string;
  duration_ms: number;
  /** False when any check failed. Warnings and skips do not fail the doctor. */
  ok: boolean;
  counts: Record<Status, number>;
  checks: CheckResult[];
}

export function buildReport(
  snapshot: StackSnapshot,
  now: Date = new Date(),
  durationMs = 0,
): DoctorReport {
  const checks = runChecks(snapshot);
  const counts: Record<Status, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status]++;
  return {
    schema: "exos.doctor.v1",
    generated_at: now.toISOString(),
    duration_ms: durationMs,
    ok: counts.fail === 0,
    counts,
    checks,
  };
}

const LABEL: Record<Status, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${LABEL[c.status]}  ${c.id}  ${c.title}`);
    lines.push(`        ${c.evidence}`);
    if (c.status !== "pass" && c.status !== "skip" && c.fix) lines.push(`        fix: ${c.fix}`);
  }
  const { pass, warn, fail, skip } = report.counts;
  lines.push("", `${pass} passed, ${warn} warnings, ${fail} failed, ${skip} skipped`);
  return lines.join("\n");
}
