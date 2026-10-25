// The 22 checks of BUILD.md §15.4, in order. Each is a pure function of a StackSnapshot.
import type { StackSnapshot } from "@exos/common";
import { exoChecks } from "./exo.ts";
import { policyChecks } from "./policy.ts";
import { runtimeChecks } from "./runtime.ts";
import { secretChecks } from "./secrets.ts";
import type { Check, CheckResult } from "./types.ts";

export type { Check, CheckResult, Status } from "./types.ts";
export { REQUIRED_DENY_RULES } from "./policy.ts";

export const CHECKS: Check[] = [
  ...exoChecks,
  ...secretChecks,
  ...policyChecks,
  ...runtimeChecks,
].sort((a, b) => a.id.localeCompare(b.id));

export function runChecks(snapshot: StackSnapshot): CheckResult[] {
  return CHECKS.map((check) => {
    const unavailable = snapshot.unavailable?.[check.id];
    if (unavailable !== undefined) {
      return { id: check.id, title: check.title, status: "skip", evidence: unavailable, fix: "" };
    }
    try {
      return { id: check.id, title: check.title, ...check.run(snapshot) };
    } catch (err) {
      // A check that cannot run must not look like a pass.
      return {
        id: check.id,
        title: check.title,
        status: "fail",
        evidence: `the check crashed: ${err instanceof Error ? err.message : String(err)}`,
        fix: "This is a bug in doctor; the snapshot may be malformed.",
      };
    }
  });
}
