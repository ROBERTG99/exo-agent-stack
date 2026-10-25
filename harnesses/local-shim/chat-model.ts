// Model access for the local-model agent (BUILD.md §4.5 `local-harness`, Appendix B local path):
// any OpenAI-compatible chat-completions endpoint on this machine, normally Ollama on
// 127.0.0.1:9842, in the fake-model's place offline. It adapts the Responses-style conversation
// that `runScriptedTurn` keeps to chat messages and back, so one tested turn loop serves both.
import type { InputItem, ModelOutput } from "../scripted/turn.ts";

export interface ChatModelOptions {
  /** Base URL including the version path, e.g. http://127.0.0.1:9842/v1. Loopback only. */
  baseUrl: string;
  model: string;
  /** OpenAI-format tool declarations offered to the model. */
  tools?: unknown[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for 429/5xx and connection errors (default 3). */
  retries?: number;
  timeoutMs?: number;
}

export class LocalModelError extends Error {
  readonly code = "local_model_unavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalModelError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

type ChatMessage = Record<string, unknown>;

/** Responses-style conversation items -> chat messages. Consecutive tool calls share one assistant message. */
export function toChatMessages(input: InputItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (item.type === "function_call") {
      const call = {
        id: String(item.call_id),
        type: "function",
        function: { name: String(item.name), arguments: String(item.arguments ?? "{}") },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
        (last.tool_calls as unknown[]).push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id),
        content: String(item.output ?? ""),
      });
    } else if (item.role === "user" || item.role === "assistant" || item.role === "system") {
      messages.push({ role: item.role, content: textOf(item.content) });
    } else if (item.role === "developer") {
      messages.push({ role: "system", content: textOf(item.content) });
    }
  }
  return messages;
}

/** A chat-completions response -> Responses-style output items. */
export function fromChatResponse(body: unknown): ModelOutput {
  if (!isObj(body) || !Array.isArray(body.choices) || !isObj(body.choices[0])) {
    throw new LocalModelError("the model answered without a choice");
  }
  const message = body.choices[0].message;
  if (!isObj(message)) throw new LocalModelError("the model answered without a message");
  const output: InputItem[] = [];
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const c of calls) {
    if (!isObj(c) || !isObj(c.function)) continue;
    output.push({
      type: "function_call",
      call_id: String(c.id),
      name: String(c.function.name),
      arguments: String(c.function.arguments ?? "{}"),
    });
  }
  if (output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: typeof message.content === "string" ? message.content : "" },
      ],
    });
  }
  const u = isObj(body.usage) ? body.usage : undefined;
  const usage =
    u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number"
      ? {
          input_tokens: u.prompt_tokens,
          output_tokens: u.completion_tokens,
          total_tokens: u.prompt_tokens + u.completion_tokens,
        }
      : undefined;
  return { output, usage };
}

/** `callModel` for runScriptedTurn backed by a local chat-completions endpoint. */
export function chatCallModel(
  opts: ChatModelOptions,
): (input: InputItem[]) => Promise<ModelOutput> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(base).host.replace(/:\d+$/, "");
  } catch {
    throw new LocalModelError(`invalid local model URL ${JSON.stringify(opts.baseUrl)}`);
  }
  if (!LOOPBACK.has(host)) {
    throw new LocalModelError(
      `the local model must be on loopback, not ${host} (BUILD.md §0.1 rail 3)`,
    );
  }
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 3;

  return async (input) => {
    const body = JSON.stringify({
      model: opts.model,
      messages: toChatMessages(input),
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(200 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`model answered ${res.status}`);
        continue;
      }
      if (!res.ok)
        throw new LocalModelError(
          `model answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      return fromChatResponse(await res.json());
    }
    throw new LocalModelError(
      `local model unavailable at ${base}: ${(lastError as Error)?.message ?? "unknown error"}`,
      {
        cause: lastError,
      },
    );
  };
}
