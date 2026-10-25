import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

/**
 * Creates (or reads) a random access token at <stateDir>/<name> with mode 0600. `local-token` is
 * what the bridge and the CLI present; `dashboard-token` only signs a person into the dashboard and
 * is never given to the bridge or to an agent.
 */
export function ensureLocalToken(stateDir: string, name = "local-token"): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, name);
  if (existsSync(file)) {
    chmodSync(file, 0o600);
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** Constant-time bearer comparison. */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const ensureDashboardToken = (stateDir: string): string =>
  ensureLocalToken(stateDir, "dashboard-token");
