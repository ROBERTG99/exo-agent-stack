import { Agent, fetch as undiciFetch } from "undici";
import type { z } from "zod";
import { ExoHttpError, ExoProtocolError, ExoUnavailableError } from "./errors.ts";
import { parseEvent, type ExoEvent } from "./events.ts";
import { backoffMs, RETRYABLE_STATUS } from "./retry.ts";
import {
  activeResponse,
  agentsResponse,
  artifactListResponse,
  cancelResponse,
  forkResponse,
  previewsResponse,
  threadListResponse,
  threadResponse,
  turnResponse,
  type ExoAgent,
  type ForkResponse,
  type ThreadListResponse,
  type ThreadResponse,
  type TurnResponse,
} from "./schemas.ts";
import { parseSse } from "./sse.ts";

export interface ExoClientOptions {
  /** Base of Exo's HTTP API, e.g. http://127.0.0.1:9810/exo */
  baseUrl: string;
  /** Sent as a bearer token when set. Whether `exo run --serve` uses one is V-1 (unverified). */
  bearerToken?: string;
  /** Retries after the first attempt for connection errors and 502/503/504 (default 3). */
  retries?: number;
  /** Whole-request timeout in ms (default 30 000). */
  requestTimeoutMs?: number;
  /** Connect timeout in ms for the default fetch (default 5 000). */
  connectTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface WriteOptions {
  /**
   * The caller guarantees the write is safe to repeat (it carries a stored idempotency key, or the
   * call is naturally idempotent). Only then are connection errors and 502/503/504 retried.
   */
  idempotent?: boolean;
}

export interface EventQuery {
  session_id?: string;
  turn_id?: string;
  after?: string;
  limit?: number;
  direction?: "asc" | "desc";
  event_type?: string;
}

export interface WatchOptions {
  after?: string;
  signal?: AbortSignal;
  /** Reconnect with `after=<last event id>` when the stream ends (default true). */
  reconnect?: boolean;
  /** Stop after yielding an event for which this returns true. */
  stopWhen?: (event: ExoEvent) => boolean;
}

type Json = Record<string, unknown>;

const seg = encodeURIComponent;
const SEEN_LIMIT = 2000;

export class ExoClient {
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly bearerToken?: string;

  constructor(opts: ExoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.retries = opts.retries ?? 3;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.bearerToken = opts.bearerToken;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    if (opts.fetch) {
      this.fetchImpl = opts.fetch;
    } else {
      const dispatcher = new Agent({ connect: { timeout: opts.connectTimeoutMs ?? 5_000 } });
      this.fetchImpl = ((url: string, init?: RequestInit) =>
        undiciFetch(url, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
    }
  }

  /** Id of the turn in a submitTurn response (the turn is an object with an id, or the id itself). */
  static turnId(response: TurnResponse): string {
    const turn = response.turn;
    return typeof turn === "string" ? turn : turn.id;
  }

  // --- agents ---------------------------------------------------------------------------------

  async listAgents(query: { slug?: string } = {}): Promise<ExoAgent[]> {
    const body = await this.call("GET", "/agent", { query });
    return parse(agentsResponse, body, "GET /agent").agents;
  }

  createManagedAgent(definition: Json, opts: WriteOptions = {}): Promise<Json> {
    return this.call("POST", "/agent/managed", { body: definition, ...opts }) as Promise<Json>;
  }

  /** PUT is naturally idempotent, so it is retried. */
  updateAgentDefinition(agentId: string, definition: Json): Promise<Json> {
    return this.call("PUT", `/agent/${seg(agentId)}/definition`, {
      body: definition,
      idempotent: true,
    }) as Promise<Json>;
  }

  agentDoctor(agentId: string): Promise<Json> {
    return this.call("GET", `/agent/${seg(agentId)}/doctor`) as Promise<Json>;
  }

  // --- threads and turns ----------------------------------------------------------------------

  async listThreads(
    agentId: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<ThreadListResponse> {
    const body = await this.call("GET", `/agent/${seg(agentId)}/thread`, { query });
    return parse(threadListResponse, body, "GET thread list");
  }

  async createThread(
    agentId: string,
    body: {
      environment?: string;
      vaults: string[];
      thread_slug?: string;
      thread_name?: string;
      harness?: string;
      model?: unknown;
    },
    opts: WriteOptions = {},
  ): Promise<ThreadResponse> {
    const res = await this.call("POST", `/agent/${seg(agentId)}/thread`, { body, ...opts });
    return parse(threadResponse, res, "POST thread");
  }

  async submitTurn(
    agentId: string,
    threadId: string,
    body: {
      input: string;
      session_id?: string;
      frontend_tools?: unknown[];
      auto_approve_tools?: string[];
      harness?: string;
      model?: unknown;
    },
    opts: WriteOptions = {},
  ): Promise<TurnResponse> {
    const res = await this.call("POST", `/agent/${seg(agentId)}/thread/${seg(threadId)}/turn`, {
      body,
      ...opts,
    });
    return parse(turnResponse, res, "POST turn");
  }

  async getTurn(agentId: string, threadId: string, turnId: string): Promise<{ active: boolean }> {
    const res = await this.call("GET", this.turnPath(agentId, threadId, turnId));
    return parse(activeResponse, res, "GET turn");
  }

  async cancelTurn(agentId: string, threadId: string, turnId: string) {
    const res = await this.call("POST", `${this.turnPath(agentId, threadId, turnId)}/cancel`, {
      idempotent: true,
    });
    return parse(cancelResponse, res, "POST turn cancel");
  }

  respondApproval(
    agentId: string,
    threadId: string,
    turnId: string,
    body: { session_id: string; approval_id: string; approved: boolean; allow_for_tool: boolean },
    opts: WriteOptions = {},
  ): Promise<unknown> {
    return this.call("POST", `${this.turnPath(agentId, threadId, turnId)}/approval-response`, {
      body,
      ...opts,
    });
  }

  sendFrontendToolResult(
    agentId: string,
    threadId: string,
    turnId: string,
    body: {
      session_id: string;
      tool_call_id: string;
      result: { type: "frontend_tool_success"; output: unknown } | Json;
    },
    opts: WriteOptions = {},
  ): Promise<unknown> {
    return this.call("POST", `${this.turnPath(agentId, threadId, turnId)}/frontend-tool-result`, {
      body,
      ...opts,
    });
  }

  async forkThread(
    agentId: string,
    threadId: string,
    body: { thread_name?: string } = {},
    opts: WriteOptions = {},
  ): Promise<ForkResponse> {
    const res = await this.call("POST", `/agent/${seg(agentId)}/thread/${seg(threadId)}/fork`, {
      body,
      ...opts,
    });
    return parse(forkResponse, res, "POST fork");
  }

  // --- events ---------------------------------------------------------------------------------

  async listEvents(agentId: string, threadId: string, query: EventQuery = {}): Promise<ExoEvent[]> {
    const res = await this.call("GET", `/agent/${seg(agentId)}/thread/${seg(threadId)}/event`, {
      query: query as Record<string, string | number | undefined>,
    });
    const list = Array.isArray(res) ? res : (res as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new ExoProtocolError("GET event: expected an events array");
    return list.map(parseEvent);
  }

  /**
   * Follows a thread's event stream (SSE). When the stream ends it reconnects with
   * `after=<last event id>`; events already delivered are skipped, so the consumer sees each id
   * once. Consecutive failed connections back off and finally raise ExoUnavailableError.
   */
  async *watchEvents(
    agentId: string,
    threadId: string,
    opts: WatchOptions = {},
  ): AsyncGenerator<ExoEvent> {
    const reconnect = opts.reconnect ?? true;
    let cursor = opts.after;
    const seen = new Set<string>();
    const order: string[] = [];
    let failures = 0;

    while (!opts.signal?.aborted) {
      let delivered = 0;
      try {
        const res = await this.rawGet(
          `/agent/${seg(agentId)}/thread/${seg(threadId)}/event/watch`,
          cursor ? { after: cursor } : {},
          opts.signal,
        );
        for await (const frame of parseSse(res)) {
          const event = parseEvent(mergeId(frame));
          cursor = event.id;
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          order.push(event.id);
          if (order.length > SEEN_LIMIT) seen.delete(order.shift()!);
          delivered++;
          yield event;
          if (opts.stopWhen?.(event)) return;
          if (opts.signal?.aborted) return;
        }
      } catch (err) {
        if (opts.signal?.aborted) return;
        if (!(err instanceof ExoUnavailableError) && !isNetworkError(err)) throw err;
        failures++;
        if (failures > this.retries) {
          throw err instanceof ExoUnavailableError
            ? err
            : new ExoUnavailableError(`event stream failed: ${(err as Error).message}`, failures, {
                cause: err,
              });
        }
        await this.sleep(backoffMs(failures - 1, this.random));
        continue;
      }
      if (!reconnect) return;
      if (delivered > 0) {
        failures = 0;
      } else {
        failures++;
        if (failures > this.retries) {
          throw new ExoUnavailableError("event stream keeps closing without events", failures);
        }
        await this.sleep(backoffMs(failures - 1, this.random));
      }
    }
  }

  // --- artifacts ------------------------------------------------------------------------------

  async listArtifacts(agentId: string, threadId: string): Promise<Json[]> {
    const res = await this.call("GET", `/agent/${seg(agentId)}/thread/${seg(threadId)}/artifact`);
    return parse(artifactListResponse, res, "GET artifact").artifacts as Json[];
  }

  readArtifact(
    agentId: string,
    threadId: string,
    query: { name: string; version?: number },
  ): Promise<Json> {
    return this.call("GET", `/agent/${seg(agentId)}/thread/${seg(threadId)}/artifact/read`, {
      query,
    }) as Promise<Json>;
  }

  async getPreviews(agentId: string, threadId: string) {
    const res = await this.call("GET", `/agent/${seg(agentId)}/thread/${seg(threadId)}/previews`);
    return parse(previewsResponse, res, "GET previews");
  }

  // --- plumbing -------------------------------------------------------------------------------

  private turnPath(agentId: string, threadId: string, turnId: string): string {
    return `/agent/${seg(agentId)}/thread/${seg(threadId)}/turn/${seg(turnId)}`;
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const suffix = qs.size > 0 ? `?${qs}` : "";
    return `${this.baseUrl}${path}${suffix}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      ...extra,
    };
  }

  /** One JSON request with the retry policy of BUILD.md §4.9. */
  private async call(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      idempotent?: boolean;
    } = {},
  ): Promise<unknown> {
    const retriable = method === "GET" || opts.idempotent === true;
    const url = this.url(path, opts.query);
    let lastError: unknown;

    for (let attempt = 0; ; attempt++) {
      const canRetry = retriable && attempt < this.retries;
      let res: Response | undefined;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: this.headers({
            accept: "application/json",
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          }),
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        lastError = err;
      }

      if (res && !RETRYABLE_STATUS.has(res.status)) return this.readBody(res, path);

      const reason = res
        ? `Exo answered ${res.status} for ${method} ${path}`
        : describeFetchError(lastError, this.requestTimeoutMs);
      if (!canRetry) {
        throw new ExoUnavailableError(
          reason,
          attempt + 1,
          lastError ? { cause: lastError } : undefined,
        );
      }
      await this.sleep(backoffMs(attempt, this.random));
    }
  }

  private async readBody(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      isJson = false;
    }
    if (!res.ok) throw new ExoHttpError(res.status, isJson ? parsed : text, path);
    if (!isJson) throw new ExoProtocolError(`${path}: response is not JSON`);
    return parsed;
  }

  /** GET that returns the response body stream (no JSON parsing); used by the SSE watcher. */
  private async rawGet(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, query), {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ExoUnavailableError(describeFetchError(err, this.requestTimeoutMs), 1, {
        cause: err,
      });
    }
    if (RETRYABLE_STATUS.has(res.status)) {
      await res.body?.cancel();
      throw new ExoUnavailableError(`Exo answered ${res.status} for GET ${path}`, 1);
    }
    if (!res.ok) throw new ExoHttpError(res.status, await res.text(), path);
    if (!res.body) throw new ExoProtocolError(`${path}: empty event stream`);
    return res.body;
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ExoProtocolError(
      `${what}: unexpected response shape (${result.error.issues[0]?.message ?? "invalid"})`,
    );
  }
  return result.data;
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `request timed out after ${timeoutMs} ms`;
  }
  return `cannot reach Exo: ${err instanceof Error ? err.message : String(err)}`;
}

/** A dropped connection while reading the stream surfaces as a TypeError ("terminated", "fetch failed"). */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ExoProtocolError("event stream: data is not valid JSON");
  }
}

function mergeId(frame: { id?: string; data: string }): unknown {
  const data = safeJson(frame.data);
  if (frame.id && typeof data === "object" && data !== null && !("id" in data)) {
    return { ...(data as object), id: frame.id };
  }
  return data;
}
