// Who is calling (BUILD.md §4.6): the bridge and the CLI present the local token as a bearer; the
// dashboard holds the `exos_session` cookie that `GET /login?t=<token>` sets. The two are told
// apart because some decisions (`dashboard_only` tools) may only be taken by a person in the
// dashboard. The cookie value is derived from the token, so it changes when the token does.
import { createHmac } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { tokenMatches } from "./token.ts";

export type Actor = "dashboard" | "api";

export const SESSION_COOKIE = "exos_session";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("exos_session").digest("hex");
}

export function setCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The caller's role, or null. A valid bearer wins over a cookie. */
export function authenticate(token: string, request: FastifyRequest): Actor | null {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer !== undefined) return tokenMatches(token, bearer) ? "api" : null;
  const cookie = cookieOf(request.headers.cookie, SESSION_COOKIE);
  return cookie !== undefined && tokenMatches(sessionValue(token), cookie) ? "dashboard" : null;
}
