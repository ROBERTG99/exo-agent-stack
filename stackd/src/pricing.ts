// Cost of a usage record in integer micro-dollars (BUILD.md §4.8). Order of trust: the cost Exo
// reports (`exo`), then tokens times the price table (`price_table`), then the table's highest
// rate (`max_estimate`, which doctor reports). Money never goes through a float except the one
// conversion of Exo's own `cost_usd`, which is rounded to the nearest micro-dollar.
import { readFileSync } from "node:fs";
import { z } from "zod";

const rate = z.number().int().nonnegative();
const rates = z.strictObject({ input: rate, cache_write: rate, cache_read: rate, output: rate });
const model = rates.extend({
  display_name: z.string(),
  long_prompt: rates.extend({ over_tokens: z.number().int().positive() }).optional(),
});

export const rateTableSchema = z.strictObject({
  version: z.literal(1),
  currency: z.literal("USD"),
  unit: z.literal("micro_dollars_per_million_tokens"),
  source_url: z.string().url(),
  retrieved_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string(),
  models: z.record(z.string(), model),
});
export type RateTable = z.infer<typeof rateTableSchema>;
type Rates = z.infer<typeof rates>;

export type CostSource = "exo" | "price_table" | "max_estimate";

export interface Usage {
  model?: string | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cached_tokens?: number;
  prompt_cache_creation_tokens?: number;
  /** A subset of completion_tokens (V-7); not billed separately. */
  completion_reasoning_tokens?: number;
  cost_usd?: number | null;
}

export function loadRates(file: string): RateTable {
  return rateTableSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Whole days between the table's retrieval date and `now` (doctor D-18 warns past 120). */
export function ratesAgeDays(table: RateTable, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${table.retrieved_at}T00:00:00Z`)) / 86_400_000);
}

/** The highest rate in each category across the table: the stand-in for a model it does not list. */
export function highestRates(table: RateTable): Rates {
  const all = Object.values(table.models).flatMap((m) => [
    m,
    ...(m.long_prompt ? [m.long_prompt] : []),
  ]);
  const top = (k: keyof Rates) => Math.max(0, ...all.map((m) => m[k]));
  return {
    input: top("input"),
    cache_write: top("cache_write"),
    cache_read: top("cache_read"),
    output: top("output"),
  };
}

/** tokens × (micro-dollars per million tokens), rounded up: an estimate never undercounts. */
function priceTokens(tokens: number, perMillion: number): number {
  if (!Number.isFinite(perMillion) || tokens <= 0 || perMillion <= 0) return 0;
  const product = BigInt(tokens) * BigInt(perMillion);
  return Number((product + 999_999n) / 1_000_000n);
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

function tokenCost(usage: Usage, r: Rates): number {
  return (
    priceTokens(count(usage.prompt_tokens), r.input) +
    priceTokens(count(usage.prompt_cache_creation_tokens), r.cache_write) +
    priceTokens(count(usage.prompt_cached_tokens), r.cache_read) +
    priceTokens(count(usage.completion_tokens), r.output)
  );
}

export function costMicros(
  usage: Usage,
  table: RateTable,
  pool: "anthropic" | "cursor" | "local" = "anthropic",
): { micros: number; source: CostSource } {
  if (pool === "local") return { micros: 0, source: "exo" };
  // A positive cost from Exo is trusted. Zero with tokens present usually means "not known".
  if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd > 0) {
    return { micros: Math.round(usage.cost_usd * 1_000_000), source: "exo" };
  }
  const tokens =
    count(usage.prompt_tokens) +
    count(usage.prompt_cached_tokens) +
    count(usage.prompt_cache_creation_tokens) +
    count(usage.completion_tokens);
  if (tokens === 0) return { micros: 0, source: "exo" };

  // Own keys only: a model id such as "constructor" must not find an inherited property.
  const entry =
    usage.model && Object.hasOwn(table.models, usage.model) ? table.models[usage.model] : undefined;
  if (!entry) return { micros: tokenCost(usage, highestRates(table)), source: "max_estimate" };
  const promptSize =
    count(usage.prompt_tokens) +
    count(usage.prompt_cached_tokens) +
    count(usage.prompt_cache_creation_tokens);
  const applicable =
    entry.long_prompt && promptSize > entry.long_prompt.over_tokens ? entry.long_prompt : entry;
  return { micros: tokenCost(usage, applicable), source: "price_table" };
}
