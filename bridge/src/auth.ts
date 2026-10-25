// Who may talk to the bridge over HTTP (BUILD.md §4.6, §15): loopback names only in Host, no
// cross-site Origin (DNS-rebinding and CSRF defence), and the local bearer token. The token is read
// from EXOS_LOCAL_TOKEN or from the stackd state directory; it is never logged or echoed.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { parseHostHeader } from "./limits.ts";

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type AuthResult =
  { ok: true } | { ok: false; status: 401 | 403; code: string; message: string };

export interface AuthRequest {
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
}

function originAllowed(origin: string, port: number): boolean {
  try {
    const u = new URL(origin);
    const name = u.hostname === "::1" ? "[::1]" : u.hostname;
    const p = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return LOOPBACK_NAMES.has(name) && p === port;
  } catch {
    return false;
  }
}

function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkRequest(req: AuthRequest, cfg: { token: string; port: number }): AuthResult {
  const host = parseHostHeader(req.host);
  if (!host || !LOOPBACK_NAMES.has(host.name) || host.port !== cfg.port) {
    return {
      ok: false,
      status: 403,
      code: "forbidden_host",
      message: "Host must be a loopback name on the bridge port",
    };
  }
  if (req.origin !== undefined && !originAllowed(req.origin, cfg.port)) {
    return {
      ok: false,
      status: 403,
      code: "forbidden_origin",
      message: "Cross-site Origin is not allowed",
    };
  }
  const bearer = req.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!tokenMatches(cfg.token, bearer)) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "A valid local bearer token is required",
    };
  }
  return { ok: true };
}

/** The API token: EXOS_LOCAL_TOKEN, else `<EXOS_STATE_DIR>/local-token`. Never the dashboard token. */
export function loadToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.EXOS_LOCAL_TOKEN?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32)
      throw new Error("EXOS_LOCAL_TOKEN is too short (at least 32 characters)");
    return fromEnv;
  }
  const file = join(env.EXOS_STATE_DIR || ".exos-state", "local-token");
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`no local token: set EXOS_LOCAL_TOKEN or start stackd (expected ${file})`);
  }
  if (text.length < 32) throw new Error(`${file} does not hold a token`);
  return text;
}
