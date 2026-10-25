// What a doctor check returns (BUILD.md §15.4): a status with the evidence it rests on and, when it
// is not a pass, the fix. Evidence is names and facts about the stack, never a secret value.
import type { StackSnapshot } from "@exos/common";

export type Status = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  evidence: string;
  fix: string;
}

export interface Check {
  id: string;
  title: string;
  run(s: StackSnapshot): Omit<CheckResult, "id" | "title">;
}

export const pass = (evidence: string) => ({ status: "pass" as const, evidence, fix: "" });
export const warn = (evidence: string, fix: string) => ({ status: "warn" as const, evidence, fix });
export const fail = (evidence: string, fix: string) => ({ status: "fail" as const, evidence, fix });
export const skip = (evidence: string) => ({ status: "skip" as const, evidence, fix: "" });

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The host part of `host:port`, `[::1]:port` or a bare host. */
export function hostOfAddress(address: string): string {
  if (address.startsWith("[")) return address.slice(0, address.indexOf("]") + 1);
  const colon = address.lastIndexOf(":");
  return colon > 0 && address.indexOf(":") === colon ? address.slice(0, colon) : address;
}

export const list = (items: string[], max = 4): string =>
  items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
