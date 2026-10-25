import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const toolStep = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const textStep = z.strictObject({ text: z.string() });
const stepSchema = z.union([toolStep, textStep]);

const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase letters, digits and dashes"),
  description: z.string().optional(),
  steps: z.array(stepSchema).min(1),
  /** Latency added to every model call of this scenario. */
  delay_ms: z.number().int().min(0).optional(),
  usage_per_step: z
    .strictObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) })
    .optional(),
});

export type Step = { tool: string; args: Record<string, unknown> } | { text: string };
export interface Scenario {
  id: string;
  steps: Step[];
  delay_ms: number;
  usage: { input_tokens: number; output_tokens: number };
}

const DEFAULT_USAGE = { input_tokens: 100, output_tokens: 20 };
const GENERATED = /^steps(\d+)$/;

export function loadScenarios(dir: string): Map<string, Scenario> {
  const out = new Map<string, Scenario>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      throw new Error(`${file}: invalid YAML (${(err as Error).message})`, { cause: err });
    }
    const parsed = scenarioSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new Error(`${file}: ${issue.path.join(".") || "scenario"}: ${issue.message}`);
    }
    const s = parsed.data;
    if (GENERATED.test(s.id))
      throw new Error(`${file}: id "${s.id}" is reserved for generated stepsN scenarios`);
    if (out.has(s.id)) throw new Error(`${file}: duplicate scenario id "${s.id}"`);
    out.set(s.id, {
      id: s.id,
      steps: s.steps.map((st) => ("tool" in st ? { tool: st.tool, args: st.args ?? {} } : st)),
      delay_ms: s.delay_ms ?? 0,
      usage: s.usage_per_step ?? DEFAULT_USAGE,
    });
  }
  return out;
}

/** A loaded scenario, or the generated `stepsN` (1..200): N ledger_append calls, then a text answer. */
export function resolveScenario(library: Map<string, Scenario>, id: string): Scenario | null {
  const known = library.get(id);
  if (known) return known;
  const m = GENERATED.exec(id);
  if (!m || m[1]!.length > 3 || String(Number(m[1])) !== m[1]) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 200) return null;
  return {
    id,
    steps: [
      ...Array.from({ length: n }, (_, i) => ({ tool: "ledger_append", args: { seq: i + 1 } })),
      { text: `Completed all ${n} steps.` },
    ],
    delay_ms: 0,
    usage: DEFAULT_USAGE,
  };
}

export interface NextStep {
  /** Present for a tool step. */
  call?: { id: string; name: string; args: Record<string, unknown> };
  text?: string;
}

/** The step to play after `toolResults` results are already in the conversation. */
export function nextStep(scenario: Scenario, toolResults: number): NextStep {
  const step = scenario.steps[toolResults];
  if (!step) return { text: `Scenario ${scenario.id} complete.` };
  if ("tool" in step) {
    return { call: { id: `call_${scenario.id}_${toolResults}`, name: step.tool, args: step.args } };
  }
  return { text: step.text };
}
