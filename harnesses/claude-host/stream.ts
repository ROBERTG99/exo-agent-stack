// Parser for `claude -p --output-format stream-json --verbose` (one JSON object per line).
// It reads only what the harness needs and ignores everything else, so new message or block
// types in a later Claude Code do not break a turn.

export type StreamMessage = Record<string, unknown> & { type: string };

export type TurnEvent =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; output: string; isError: boolean }
  | { kind: "result"; subtype?: string; isError: boolean; text?: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseStreamLine(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isObj(value) && typeof value.type === "string" ? (value as StreamMessage) : null;
}

function blocks(msg: StreamMessage): Record<string, unknown>[] {
  const message = msg.message;
  if (!isObj(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObj);
}

function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

export function eventsOf(msg: StreamMessage): TurnEvent[] {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" && typeof msg.session_id === "string"
        ? [
            {
              kind: "init",
              sessionId: msg.session_id,
              model: typeof msg.model === "string" ? msg.model : undefined,
            },
          ]
        : [];
    case "assistant":
      return blocks(msg).flatMap((b): TurnEvent[] => {
        if (b.type === "text" && typeof b.text === "string")
          return [{ kind: "text", text: b.text }];
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          return [{ kind: "tool_call", id: b.id, name: b.name, input: b.input ?? {} }];
        }
        return [];
      });
    case "user":
      return blocks(msg).flatMap((b): TurnEvent[] =>
        b.type === "tool_result" && typeof b.tool_use_id === "string"
          ? [
              {
                kind: "tool_result",
                id: b.tool_use_id,
                output: outputText(b.content),
                isError: b.is_error === true,
              },
            ]
          : [],
      );
    case "result":
      return [
        {
          kind: "result",
          subtype: typeof msg.subtype === "string" ? msg.subtype : undefined,
          isError:
            msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success"),
          text: typeof msg.result === "string" ? msg.result : undefined,
        },
      ];
    default:
      return [];
  }
}

export interface TurnOutcome {
  sessionId?: string;
  model?: string;
  resultText?: string;
  isError: boolean;
  subtype?: string;
  errorReason?: string;
  usage?: Record<string, number>;
  costUsd?: number;
  durationMs?: number;
  badLines: number;
}

export class TurnCollector {
  private sessionId?: string;
  private model?: string;
  private result?: StreamMessage;
  private bad = 0;

  /** Feeds one stdout line; returns the events it carries. */
  feed(line: string): TurnEvent[] {
    const msg = parseStreamLine(line);
    if (!msg) {
      if (line.trim() !== "") this.bad++;
      return [];
    }
    const events = eventsOf(msg);
    for (const e of events) {
      if (e.kind === "init") {
        this.sessionId = e.sessionId;
        this.model = e.model ?? this.model;
      }
    }
    if (msg.type === "result") this.result = msg;
    return events;
  }

  outcome(): TurnOutcome {
    const r = this.result;
    if (!r) {
      return {
        sessionId: this.sessionId,
        model: this.model,
        isError: true,
        errorReason: "no result message in the stream",
        badLines: this.bad,
      };
    }
    const subtype = typeof r.subtype === "string" ? r.subtype : undefined;
    const isError = r.is_error === true || (subtype !== undefined && subtype !== "success");
    return {
      sessionId: typeof r.session_id === "string" ? r.session_id : this.sessionId,
      model: this.model,
      resultText: typeof r.result === "string" ? r.result : undefined,
      isError,
      subtype,
      errorReason: isError ? `claude finished with ${subtype ?? "an error"}` : undefined,
      usage: isObj(r.usage) ? (r.usage as Record<string, number>) : undefined,
      costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      badLines: this.bad,
    };
  }
}

export interface ExoUsage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cached_tokens: number;
  prompt_cache_creation_tokens: number;
  completion_reasoning_tokens: number;
  cost_usd?: number;
  duration_ms?: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The `messages.usage` of BUILD.md §4.2 (V-7). Assumption: prompt_tokens is the whole prompt
 * (uncached input + cache creation + cache reads), which is how the meter prices it. cost_usd is
 * Claude Code's own estimate at API rates, so it is an API-rate equivalent, not a bill.
 */
export function toExoUsage(outcome: TurnOutcome, fallbackModel = "unknown"): ExoUsage | null {
  const u = outcome.usage;
  if (!u) return null;
  const usage: ExoUsage = {
    model: outcome.model ?? fallbackModel,
    prompt_tokens:
      n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
    completion_tokens: n(u.output_tokens),
    prompt_cached_tokens: n(u.cache_read_input_tokens),
    prompt_cache_creation_tokens: n(u.cache_creation_input_tokens),
    completion_reasoning_tokens: 0,
  };
  if (outcome.costUsd !== undefined) usage.cost_usd = outcome.costUsd;
  if (outcome.durationMs !== undefined) usage.duration_ms = outcome.durationMs;
  return usage;
}
