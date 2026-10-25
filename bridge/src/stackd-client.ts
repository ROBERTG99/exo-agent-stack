// A small client for stackd's REST API. The bridge only ever calls stackd, never Exo.
import { BridgeError, fromProblem } from "./errors.ts";
import type { BridgeContext } from "./context.ts";

const TIMEOUT_MS = 35_000;

export interface Call {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export async function stackd<T = Record<string, unknown>>(
  ctx: BridgeContext,
  call: Call,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = `${ctx.stackdUrl}${call.path}${qs.size > 0 ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, {
      method: call.method ?? "GET",
      headers: {
        authorization: `Bearer ${ctx.stackdToken}`,
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new BridgeError("stack_unavailable", "stackd is not reachable: is the stack running?", {
      reason: err instanceof Error ? err.name : "error",
    });
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new BridgeError("internal_error", "stackd sent a reply that is not JSON", {
      status: res.status,
    });
  }
  if (!res.ok) throw fromProblem(res.status, body);
  return body as T;
}

export interface ThreadRef {
  agent: string;
  thread: string;
}

/** `<agent>/<slug>`, a unique slug or an id, to the one thread it names. */
export async function resolveThread(ctx: BridgeContext, ref: string): Promise<ThreadRef> {
  const { matches } = await stackd<{
    matches: Array<{ agent_slug: string; thread_slug: string }>;
  }>(ctx, { path: "/api/v1/threads/resolve", query: { thread: ref } });
  if (matches.length === 0)
    throw new BridgeError("not_found", `no thread matches "${ref.slice(0, 80)}"`);
  if (matches.length > 1) {
    throw new BridgeError(
      "ambiguous_thread",
      `"${ref.slice(0, 80)}" names several threads: qualify it as <agent>/<slug>`,
      {
        matches: matches.map((m) => `${m.agent_slug}/${m.thread_slug}`),
      },
    );
  }
  return { agent: matches[0]!.agent_slug, thread: matches[0]!.thread_slug };
}
