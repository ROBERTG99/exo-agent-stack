// Turning Exo events into the views stackd serves. The rule that matters: `summary` is written by
// this code from event types and short identifiers only, so it can never carry an instruction from
// an agent; anything an agent wrote (message text, tool output, error text, a question) goes into
// `untrusted_text` and is labelled as such by every consumer (BUILD.md §15). Unknown event types
// are shown generically (§4.2).
import type { ExoEvent } from "@exos/exo-client";

export interface EventView {
  id: string;
  type: string;
  ts: string | null;
  turn_id: string | null;
  session_id: string | null;
  summary: string;
  tool?: string;
  untrusted_text?: string;
  usage?: Record<string, number | string>;
  /** The event as Exo sent it. Contains agent-written text: treat it as untrusted. */
  data: Record<string, unknown>;
}

/** A short identifier that cannot smuggle a sentence into a summary. */
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const token = (v: unknown): string | undefined =>
  typeof v === "string" && TOKEN.test(v) ? v : undefined;
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Message text: a string, or the text parts of a content array. */
function messageText(e: Record<string, unknown>): string | undefined {
  if (text(e.text)) return e.text as string;
  if (typeof e.content === "string") return text(e.content);
  if (Array.isArray(e.content)) {
    const parts = e.content
      .map((c) =>
        c && typeof c === "object" ? text((c as Record<string, unknown>).text) : undefined,
      )
      .filter((t): t is string => t !== undefined);
    return parts.length ? parts.join("") : undefined;
  }
  return undefined;
}

const toolName = (e: Record<string, unknown>): string | undefined =>
  token(e.tool) ?? token(e.name) ?? token(e.tool_name);

function usageOf(raw: unknown): Record<string, number | string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (k === "model" && token(v)) out[k] = v as string;
  }
  return Object.keys(out).length ? out : undefined;
}

export function viewOf(event: ExoEvent): EventView {
  const e = event as Record<string, unknown>;
  const type = String(event.type);
  const view: EventView = {
    id: event.id,
    type,
    ts: text(e.ts) ?? text(e.timestamp) ?? text(e.created_at) ?? null,
    turn_id: text(e.turn_id) ?? null,
    session_id: text(e.session_id) ?? null,
    summary: "",
    data: e,
  };
  const tool = toolName(e);

  switch (type) {
    case "thread_created":
      view.summary = "thread created";
      break;
    case "thread_forked":
      view.summary = "thread forked";
      break;
    case "session_started":
      view.summary = "session started";
      break;
    case "turn_started":
      view.summary = "turn started";
      break;
    case "turn_ended": {
      const status = token(e.status);
      view.summary = status ? `turn ended (${status})` : "turn ended";
      break;
    }
    case "messages": {
      const usage = usageOf(e.usage);
      const role = token(e.role);
      if (usage) {
        view.usage = usage;
        const tokens = (num(usage.prompt_tokens) ?? 0) + (num(usage.completion_tokens) ?? 0);
        view.summary = `usage recorded (${tokens} tokens)`;
      } else {
        view.summary = `${role ?? "unknown"} message`;
      }
      const body = messageText(e);
      if (body) view.untrusted_text = body;
      break;
    }
    case "tool_requested":
      view.summary = `tool requested: ${tool ?? "unknown"}`;
      if (tool) view.tool = tool;
      break;
    case "tool_result": {
      view.summary = `tool result: ${tool ?? "unknown"}`;
      if (tool) view.tool = tool;
      const output = text(e.output);
      if (output) view.untrusted_text = output;
      break;
    }
    case "error": {
      view.summary = "error";
      const message = text(e.message);
      if (message) view.untrusted_text = message;
      break;
    }
    case "artifact_written": {
      const name = token(e.name);
      const version = num(e.version);
      view.summary = name
        ? `artifact ${name} written${version !== undefined ? ` (version ${version})` : ""}`
        : "artifact written";
      break;
    }
    case "sandbox_snapshotted":
      view.summary = "sandbox snapshotted";
      break;
    case "agent_runtime.approval_requested":
      view.summary = `approval requested: ${tool ?? "unknown"}`;
      if (tool) view.tool = tool;
      break;
    case "agent_runtime.approval_response":
      view.summary = e.approved === true ? "approval granted" : "approval denied";
      break;
    case "frontend_tool_requested": {
      view.summary = `question for the human (${tool ?? "unknown"})`;
      if (tool) view.tool = tool;
      const args = e.arguments as Record<string, unknown> | undefined;
      const question = text(args?.question);
      if (question) view.untrusted_text = question;
      break;
    }
    case "frontend_tool_result":
      view.summary = "answer received";
      break;
    default:
      view.summary = `event of type ${token(type) ?? "unknown type"}`;
  }
  return view;
}
