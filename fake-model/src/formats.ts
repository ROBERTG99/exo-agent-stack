// Request parsing and response building for the three wire formats the fake model speaks. These
// follow the public OpenAI Responses, OpenAI chat-completions and Anthropic messages formats; the
// subset implemented is what the harnesses and Claude Code use. How Exo's own harness library
// consumes them is verified when the pinned source is available (docs/KNOWN_LIMITATIONS.md).
import { createHash } from "node:crypto";
import type { NextStep, Scenario } from "./scenarios.ts";

export interface ParsedRequest {
  model: string;
  stream: boolean;
  /** From the [[scenario:<id>]] marker of the first user message; "plain" when absent. */
  scenarioId: string;
  /** Tool results already in the conversation = index of the step to play now. */
  toolResults: number;
}

const MARKER = /\[\[scenario:([A-Za-z0-9_-]+)\]\]/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("\n");
  }
  return "";
}

const scenarioOf = (firstUserText: string): string => MARKER.exec(firstUserText)?.[1] ?? "plain";

export function parseResponses(body: unknown): ParsedRequest | null {
  if (!isObj(body)) return null;
  const input = body.input;
  if (typeof input === "string") {
    return {
      model: modelOf(body),
      stream: body.stream === true,
      scenarioId: scenarioOf(input),
      toolResults: 0,
    };
  }
  if (!Array.isArray(input)) return null;
  const firstUser = input.find((i) => isObj(i) && i.role === "user");
  if (!firstUser) return null;
  const toolResults = input.filter((i) => isObj(i) && i.type === "function_call_output").length;
  return {
    model: modelOf(body),
    stream: body.stream === true,
    scenarioId: scenarioOf(textOf((firstUser as Record<string, unknown>).content)),
    toolResults,
  };
}

export function parseChat(body: unknown): ParsedRequest | null {
  if (!isObj(body) || !Array.isArray(body.messages)) return null;
  const firstUser = body.messages.find((m) => isObj(m) && m.role === "user");
  if (!firstUser) return null;
  const toolResults = body.messages.filter((m) => isObj(m) && m.role === "tool").length;
  return {
    model: modelOf(body),
    stream: body.stream === true,
    scenarioId: scenarioOf(textOf((firstUser as Record<string, unknown>).content)),
    toolResults,
  };
}

export function parseMessages(body: unknown): ParsedRequest | null {
  if (!isObj(body) || !Array.isArray(body.messages)) return null;
  const firstUser = body.messages.find((m) => isObj(m) && m.role === "user");
  if (!firstUser) return null;
  let toolResults = 0;
  for (const m of body.messages) {
    if (isObj(m) && m.role === "user" && Array.isArray(m.content)) {
      toolResults += m.content.filter((b) => isObj(b) && b.type === "tool_result").length;
    }
  }
  return {
    model: modelOf(body),
    stream: body.stream === true,
    scenarioId: scenarioOf(textOf((firstUser as Record<string, unknown>).content)),
    toolResults,
  };
}

function modelOf(body: Record<string, unknown>): string {
  return typeof body.model === "string" && body.model ? body.model : "fake-model";
}

/** Stable, readable ids: the same scenario step always gets the same ids. */
const tag = (scenario: Scenario, index: number, prefix: string): string =>
  `${prefix}_${createHash("sha256").update(`${scenario.id}:${index}`).digest("hex").slice(0, 16)}`;

const sse = (event: string | null, data: unknown): string =>
  `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

export interface Built {
  contentType: "application/json" | "text/event-stream";
  body: unknown;
}

// --- OpenAI Responses -------------------------------------------------------------------------

export function buildResponses(req: ParsedRequest, step: NextStep, scenario: Scenario): Built {
  const { input_tokens, output_tokens } = scenario.usage;
  const id = tag(scenario, req.toolResults, "resp");
  const item = step.call
    ? {
        type: "function_call",
        id: tag(scenario, req.toolResults, "fc"),
        call_id: step.call.id,
        name: step.call.name,
        arguments: JSON.stringify(step.call.args),
        status: "completed",
      }
    : {
        type: "message",
        id: tag(scenario, req.toolResults, "msg"),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: step.text ?? "", annotations: [] }],
      };
  const response = {
    id,
    object: "response",
    created_at: 0,
    status: "completed",
    model: req.model,
    output: [item],
    usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens },
  };
  if (!req.stream) return { contentType: "application/json", body: response };

  const events: string[] = [
    sse("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    }),
  ];
  if (!step.call) {
    events.push(
      sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: step.text ?? "",
      }),
    );
  }
  events.push(
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
    sse("response.completed", { type: "response.completed", response }),
  );
  return { contentType: "text/event-stream", body: events.join("") };
}

// --- OpenAI chat completions ------------------------------------------------------------------

export function buildChat(req: ParsedRequest, step: NextStep, scenario: Scenario): Built {
  const { input_tokens: prompt_tokens, output_tokens: completion_tokens } = scenario.usage;
  const usage = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
  const id = tag(scenario, req.toolResults, "chatcmpl");
  const toolCall = step.call && {
    id: step.call.id,
    type: "function",
    function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
  };
  const finish = step.call ? "tool_calls" : "stop";
  if (!req.stream) {
    return {
      contentType: "application/json",
      body: {
        id,
        object: "chat.completion",
        created: 0,
        model: req.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: step.call ? null : (step.text ?? ""),
              ...(toolCall ? { tool_calls: [toolCall] } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      },
    };
  }
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    sse(null, {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: req.model,
      choices: [{ index: 0, delta, finish_reason }],
    });
  const parts = [
    chunk({ role: "assistant" }),
    step.call
      ? chunk({ tool_calls: [{ index: 0, ...toolCall }] })
      : chunk({ content: step.text ?? "" }),
    chunk({}, finish),
    sse(null, {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: req.model,
      choices: [],
      usage,
    }),
    sse(null, "[DONE]"),
  ];
  return { contentType: "text/event-stream", body: parts.join("") };
}

// --- Anthropic messages (subset) --------------------------------------------------------------

export function buildMessages(req: ParsedRequest, step: NextStep, scenario: Scenario): Built {
  const { input_tokens, output_tokens } = scenario.usage;
  const id = tag(scenario, req.toolResults, "msg");
  const block = step.call
    ? { type: "tool_use", id: step.call.id, name: step.call.name, input: step.call.args }
    : { type: "text", text: step.text ?? "" };
  const stop_reason = step.call ? "tool_use" : "end_turn";
  const message = {
    id,
    type: "message",
    role: "assistant",
    model: req.model,
    content: [block],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens, output_tokens },
  };
  if (!req.stream) return { contentType: "application/json", body: message };

  const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
  const delta =
    block.type === "text"
      ? { type: "text_delta", text: block.text }
      : { type: "input_json_delta", partial_json: JSON.stringify(step.call!.args) };
  const events = [
    sse("message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens, output_tokens: 0 },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: start }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason, stop_sequence: null },
      usage: { output_tokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
  return { contentType: "text/event-stream", body: events.join("") };
}
