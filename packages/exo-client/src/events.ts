import { ExoProtocolError } from "./errors.ts";

/** An Exo thread event. Only `id` and `type` are relied on; unknown types and fields pass through. */
export interface ExoEvent {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface ExoUsage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cached_tokens: number;
  prompt_cache_creation_tokens: number;
  completion_reasoning_tokens: number;
  cost_usd?: number;
  ttft_ms?: number;
  duration_ms?: number;
}

export function parseEvent(raw: unknown): ExoEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ExoProtocolError("event is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new ExoProtocolError("event has no id");
  }
  if (typeof obj.type !== "string" || obj.type === "") {
    throw new ExoProtocolError("event has no type");
  }
  return { ...obj, id: String(id), type: obj.type };
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const optNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Token usage and cost of a `messages` event, or null when the event carries none. */
export function usageOf(event: ExoEvent): ExoUsage | null {
  if (event.type !== "messages") return null;
  const u = event.usage;
  if (typeof u !== "object" || u === null) return null;
  const r = u as Record<string, unknown>;
  const usage: ExoUsage = {
    model: typeof r.model === "string" ? r.model : "unknown",
    prompt_tokens: num(r.prompt_tokens),
    completion_tokens: num(r.completion_tokens),
    prompt_cached_tokens: num(r.prompt_cached_tokens),
    prompt_cache_creation_tokens: num(r.prompt_cache_creation_tokens),
    completion_reasoning_tokens: num(r.completion_reasoning_tokens),
  };
  const cost = optNum(r.cost_usd);
  const ttft = optNum(r.ttft_ms);
  const duration = optNum(r.duration_ms);
  if (cost !== undefined) usage.cost_usd = cost;
  if (ttft !== undefined) usage.ttft_ms = ttft;
  if (duration !== undefined) usage.duration_ms = duration;
  return usage;
}
