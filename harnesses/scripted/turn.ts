// The scripted harness's turn loop (BUILD.md §4.7), independent of how Exo hands it a turn.
// It talks to a model over the OpenAI Responses format (the fake model offline) and keeps no state
// of its own: everything it needs to continue after a crash is read back from the durable
// conversation through the ports. That is what makes a replay yield the same next step and execute
// each tool call exactly once.
export { appendLedger, ledgerStats } from "./ledger.ts";

export type InputItem = Record<string, unknown>;

export interface ModelOutput {
  output: InputItem[];
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TurnPorts {
  /** The durable conversation so far in Responses input form, ending with the latest user message. */
  conversation(): Promise<InputItem[]>;
  callModel(input: InputItem[]): Promise<ModelOutput>;
  /** The recorded result of a tool call, if one survived (undefined when it never completed). */
  existingResult(callId: string): Promise<string | undefined>;
  recordToolCall(call: ToolCall): Promise<void>;
  /** Executes the tool. Must be idempotent by call.id: after a crash it can run again. */
  runTool(call: ToolCall): Promise<string>;
  recordResult(call: ToolCall, output: string): Promise<void>;
  emitText(text: string): Promise<void>;
  recordUsage(usage: NonNullable<ModelOutput["usage"]>): Promise<void>;
  maxRoundTrips: number;
}

export interface TurnSummary {
  text: string;
  /** Tool calls executed by this invocation (calls found already done are not counted). */
  toolCalls: number;
  roundTrips: number;
}

function callsIn(output: InputItem[]): ToolCall[] {
  return output
    .filter((i) => i.type === "function_call")
    .map((i) => ({
      id: String(i.call_id),
      name: String(i.name),
      args: JSON.parse(String(i.arguments ?? "{}")) as Record<string, unknown>,
    }));
}

function textIn(output: InputItem[]): string {
  return output
    .filter((i) => i.type === "message")
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as InputItem[]) : []))
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("");
}

export async function runScriptedTurn(ports: TurnPorts): Promise<TurnSummary> {
  let toolCalls = 0;
  for (let roundTrips = 1; roundTrips <= ports.maxRoundTrips; roundTrips++) {
    const out = await ports.callModel(await ports.conversation());
    if (out.usage) await ports.recordUsage(out.usage);

    const calls = callsIn(out.output);
    if (calls.length === 0) {
      const text = textIn(out.output);
      await ports.emitText(text);
      return { text, toolCalls, roundTrips };
    }

    for (const call of calls) {
      // A result that survived the crash means the call is done: never run it again.
      if ((await ports.existingResult(call.id)) !== undefined) continue;
      await ports.recordToolCall(call);
      let output: string;
      try {
        output = await ports.runTool(call);
      } catch (err) {
        output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      await ports.recordResult(call, output);
      toolCalls++;
    }
  }
  throw new Error(`scripted turn exceeded ${ports.maxRoundTrips} model round trips`);
}
