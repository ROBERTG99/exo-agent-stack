// Looking up threads in Exo and deriving a thread's state from its events. Exo owns the data;
// nothing here is copied into SQLite (BUILD.md §4.4).
import type { ExoClient, ExoEvent } from "@exos/exo-client";
import { poolOf, type AgentInfo } from "./agents.ts";
import type { AppContext } from "./context.ts";
import { notFound } from "./errors.ts";

export interface ThreadInfo {
  id: string;
  slug: string;
  name: string | null;
  environment: string | null;
}

export type ThreadState =
  "idle" | "running" | "awaiting_approval" | "awaiting_input" | "interrupted" | "failed_recovery";

export interface ThreadStatus {
  thread_id: string;
  thread_slug: string;
  agent_id: string;
  state: ThreadState;
  active_turn_id: string | null;
  pending: number;
  last_event_id: string | null;
  cost_usd: number;
  credit_state: "ok" | "warn" | "stop";
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function asThread(raw: Record<string, unknown>): ThreadInfo {
  const id = String(raw.id);
  return {
    id,
    slug: str(raw.slug) ?? str(raw.thread_slug) ?? id,
    name: str(raw.name) ?? str(raw.thread_name),
    environment: str(raw.environment),
  };
}

const MAX_PAGES = 20;

/** Every thread of an agent (bounded: a personal stack has few). */
export async function listThreads(exo: ExoClient, agentId: string): Promise<ThreadInfo[]> {
  const out: ThreadInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await exo.listThreads(agentId, { limit: 200, cursor });
    out.push(...res.threads.map((t) => asThread(t as Record<string, unknown>)));
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

/** `<agent>/<thread>`: the agent by slug or id, the thread by unique slug or id. */
export async function resolveThread(
  ctx: Pick<AppContext, "agents" | "exo">,
  agentRef: string,
  threadRef: string,
): Promise<{ agent: AgentInfo; thread: ThreadInfo }> {
  const agent = await ctx.agents.resolve(agentRef);
  const thread = (await listThreads(ctx.exo, agent.id)).find(
    (t) => t.slug === threadRef || t.id === threadRef,
  );
  if (!thread) throw notFound(`thread ${threadRef}`);
  return { agent, thread };
}

const field = (e: ExoEvent, name: string): string | null =>
  str((e as Record<string, unknown>)[name]);

/** Opened-but-unanswered approvals and frontend tool calls among `events` (any order). */
export function openRequests(events: ExoEvent[]): { approvals: string[]; inputs: string[] } {
  const answeredApprovals = new Set(
    events
      .filter((e) => e.type === "agent_runtime.approval_response")
      .map((e) => field(e, "approval_id")),
  );
  const answeredInputs = new Set(
    events
      .filter((e) => e.type === "frontend_tool_result")
      .map((e) => field(e, "call_id") ?? field(e, "tool_call_id")),
  );
  return {
    approvals: events
      .filter((e) => e.type === "agent_runtime.approval_requested")
      .map((e) => field(e, "approval_id"))
      .filter((id): id is string => id !== null && !answeredApprovals.has(id)),
    inputs: events
      .filter((e) => e.type === "frontend_tool_requested")
      .map((e) => field(e, "call_id") ?? field(e, "tool_call_id"))
      .filter((id): id is string => id !== null && !answeredInputs.has(id)),
  };
}

const WINDOW = 200;

export async function threadStatus(
  ctx: AppContext,
  agent: AgentInfo,
  thread: ThreadInfo,
): Promise<ThreadStatus> {
  const newestFirst = await ctx.exo.listEvents(agent.id, thread.id, {
    direction: "desc",
    limit: WINDOW,
  });
  const events = [...newestFirst].reverse();
  const started = [...events].reverse().find((e) => e.type === "turn_started");
  const startedTurn = started ? field(started, "turn_id") : null;
  const ended = startedTurn
    ? events.some((e) => e.type === "turn_ended" && field(e, "turn_id") === startedTurn)
    : true;

  let active: string | null = null;
  let cutOff: string | null = null;
  if (startedTurn && !ended) {
    if ((await ctx.exo.getTurn(agent.id, thread.id, startedTurn)).active) active = startedTurn;
    else cutOff = startedTurn; // not active, and it never ended: the supervisor's to continue
  }
  const open = active
    ? openRequests(events.filter((e) => field(e, "turn_id") === active))
    : { approvals: [], inputs: [] };
  const state: ThreadState = cutOff
    ? ctx.supervisor.recoveryOutcome(cutOff)
    : !active
      ? "idle"
      : open.approvals.length > 0
        ? "awaiting_approval"
        : open.inputs.length > 0
          ? "awaiting_input"
          : "running";

  const cost = ctx.db
    .prepare("SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM usage_events WHERE thread_id = ?")
    .get(thread.id) as { micros: number };
  return {
    thread_id: thread.id,
    thread_slug: thread.slug,
    agent_id: agent.id,
    state,
    active_turn_id: active,
    pending: open.approvals.length + open.inputs.length,
    last_event_id: newestFirst[0]?.id ?? null,
    cost_usd: cost.micros / 1_000_000,
    credit_state: ctx.credit.state(poolOf(agent)),
  };
}
