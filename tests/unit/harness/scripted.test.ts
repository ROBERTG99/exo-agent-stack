import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFakeModel } from "@exos/fake-model/server";
import {
  appendLedger,
  ledgerStats,
  runScriptedTurn,
  type InputItem,
  type ModelOutput,
  type ToolCall,
  type TurnPorts,
} from "../../../harnesses/scripted/turn.ts";

/** Calls the fake model in-process through its Responses endpoint. */
async function modelFor() {
  const app = await buildFakeModel();
  return {
    close: () => app.close(),
    call: async (input: InputItem[]): Promise<ModelOutput> => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { model: "fake-model", input },
      });
      if (res.statusCode !== 200) throw new Error(`model answered ${res.statusCode}: ${res.body}`);
      return res.json() as ModelOutput;
    },
  };
}

/** A durable in-memory thread: what Exo's event log provides to the real harness. */
class Thread {
  items: InputItem[];
  results = new Map<string, string>();
  calls: ToolCall[] = [];
  texts: string[] = [];
  usage: unknown[] = [];
  constructor(prompt: string) {
    this.items = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
  }
}

function ports(
  thread: Thread,
  model: Awaited<ReturnType<typeof modelFor>>,
  runTool: (call: ToolCall) => Promise<string>,
  hooks: { beforeRecord?: (call: ToolCall) => void; afterRecord?: (call: ToolCall) => void } = {},
): TurnPorts {
  return {
    conversation: async () => thread.items,
    callModel: (input) => model.call(input),
    existingResult: async (id) => thread.results.get(id),
    recordToolCall: async (call) => {
      thread.calls.push(call);
      thread.items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      });
    },
    runTool: async (call) => {
      return runTool(call);
    },
    recordResult: async (call, output) => {
      hooks.beforeRecord?.(call); // a kill here lands after the tool ran, before its result is durable
      thread.results.set(call.id, output);
      thread.items.push({ type: "function_call_output", call_id: call.id, output });
      hooks.afterRecord?.(call);
    },
    emitText: async (t) => void thread.texts.push(t),
    recordUsage: async (u) => void thread.usage.push(u),
    maxRoundTrips: 256,
  };
}

const ledgerTool = (path: string) => async (call: ToolCall) => {
  if (call.name !== "ledger_append") throw new Error(`unexpected tool ${call.name}`);
  return JSON.stringify(
    appendLedger(path, { tool_call_id: call.id, seq: call.args.seq as number }),
  );
};

class Crash extends Error {}

describe("runScriptedTurn", () => {
  it("runs a plain scenario to its text answer", async () => {
    const model = await modelFor();
    const t = new Thread("hello [[scenario:plain]]");
    const r = await runScriptedTurn(ports(t, model, async () => "{}"));
    expect(r).toMatchObject({ text: "Plain scenario answer.", toolCalls: 0, roundTrips: 1 });
    expect(t.texts).toEqual(["Plain scenario answer."]);
    expect(t.usage).toHaveLength(1);
    await model.close();
  });

  it("executes a 12-step scenario in order with deterministic call ids", async () => {
    const model = await modelFor();
    const ledger = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
    const t = new Thread("go [[scenario:steps12]]");
    const r = await runScriptedTurn(ports(t, model, ledgerTool(ledger)));
    expect(r.toolCalls).toBe(12);
    expect(t.calls.map((c) => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `call_steps12_${i}`),
    );
    expect(ledgerStats(ledger)).toEqual({
      entries: 12,
      unique: 12,
      duplicates: 0,
      seqs: Array.from({ length: 12 }, (_, i) => i + 1),
    });
    expect(t.usage).toHaveLength(13);
    await model.close();
  });

  it("resumes after a crash between steps without repeating completed calls", async () => {
    const model = await modelFor();
    const ledger = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
    const t = new Thread("go [[scenario:steps12]]");
    let recorded = 0;
    const crashing = ports(t, model, ledgerTool(ledger), {
      afterRecord: () => {
        if (++recorded === 6) throw new Crash("SIGKILL at step 6");
      },
    });
    await expect(runScriptedTurn(crashing)).rejects.toBeInstanceOf(Crash);
    expect(ledgerStats(ledger).entries).toBe(6);

    // A new process picks the same durable thread up and finishes the turn.
    const r = await runScriptedTurn(ports(t, model, ledgerTool(ledger)));
    expect(r.text).toMatch(/Completed all 12 steps/);
    expect(ledgerStats(ledger)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
    await model.close();
  });

  it("absorbs the replay when the crash hits after the tool ran but before its result was recorded", async () => {
    const model = await modelFor();
    const ledger = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
    const t = new Thread("go [[scenario:steps12]]");
    let executed = 0;
    const crashing = ports(t, model, ledgerTool(ledger), {
      beforeRecord: () => {
        if (++executed === 7) throw new Crash("killed after executing step 7, before recording");
      },
    });
    await expect(runScriptedTurn(crashing)).rejects.toBeInstanceOf(Crash);
    expect(ledgerStats(ledger).entries).toBe(7);
    expect(t.results.has("call_steps12_6")).toBe(false);

    await runScriptedTurn(ports(t, model, ledgerTool(ledger)));
    // The ledger tool is idempotent by tool_call_id, so the re-execution adds no second line.
    expect(ledgerStats(ledger)).toMatchObject({ entries: 12, unique: 12, duplicates: 0 });
    await model.close();
  });

  it("is a no-op when the turn already finished (a replay after the final record)", async () => {
    const model = await modelFor();
    const ledger = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
    const t = new Thread("go [[scenario:steps8]]");
    await runScriptedTurn(ports(t, model, ledgerTool(ledger)));
    const before = t.calls.length;
    await runScriptedTurn(ports(t, model, ledgerTool(ledger)));
    expect(t.calls.length).toBe(before);
    expect(ledgerStats(ledger)).toMatchObject({ entries: 8, duplicates: 0 });
    await model.close();
  });

  it("stops with an error when the model keeps asking for tools beyond the round-trip cap", async () => {
    const model = await modelFor();
    const t = new Thread("go [[scenario:steps12]]");
    const p = {
      ...ports(t, model, ledgerTool(join(mkdtempSync(join(tmpdir(), "l-")), "l.jsonl"))),
      maxRoundTrips: 5,
    };
    await expect(runScriptedTurn(p)).rejects.toThrow(/round trips/i);
    await model.close();
  });

  it("propagates a tool failure as the tool result so the model can see it", async () => {
    const model = await modelFor();
    const t = new Thread("go [[scenario:steps8]]");
    const failing = ports(t, model, async (call) => {
      if (call.id === "call_steps8_2") throw new Error("disk full");
      return "{}";
    });
    const r = await runScriptedTurn(failing);
    expect(t.results.get("call_steps8_2")).toMatch(/error.*disk full/i);
    expect(r.text).toMatch(/Completed all 8 steps/);
    await model.close();
  });
});

describe("ledger", () => {
  it("appends one JSON line per new tool call id and absorbs a repeat", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
    expect(appendLedger(file, { tool_call_id: "a", seq: 1 })).toEqual({
      ok: true,
      seq: 1,
      absorbed: false,
    });
    expect(appendLedger(file, { tool_call_id: "b", seq: 2 })).toMatchObject({ absorbed: false });
    expect(appendLedger(file, { tool_call_id: "a", seq: 1 })).toEqual({
      ok: true,
      seq: 1,
      absorbed: true,
    });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(`${file}.absorbed`)).toBe(true);
    expect(readFileSync(`${file}.absorbed`, "utf8").trim().split("\n")).toEqual(["a"]);
  });

  it("reports duplicates when a ledger was written without idempotency", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
    appendLedger(file, { tool_call_id: "a", seq: 1 });
    // Simulate a buggy harness appending the same id again.
    appendFileSync(file, JSON.stringify({ tool_call_id: "a", seq: 1 }) + "\n");
    expect(ledgerStats(file)).toMatchObject({ entries: 2, unique: 1, duplicates: 1 });
  });

  it("reports an empty ledger for a missing file", () => {
    expect(ledgerStats(join(tmpdir(), "no-such-ledger.jsonl"))).toEqual({
      entries: 0,
      unique: 0,
      duplicates: 0,
      seqs: [],
    });
  });
});
