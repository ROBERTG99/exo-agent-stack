import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TurnCollector,
  eventsOf,
  parseStreamLine,
  toExoUsage,
} from "../../../harnesses/claude-host/stream.ts";

const sample = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "fixtures", "claude-stream", "sample.ndjson"),
  "utf8",
)
  .trim()
  .split("\n");

describe("parseStreamLine", () => {
  it("parses a JSON object with a type", () => {
    expect(parseStreamLine(sample[0]!)).toMatchObject({ type: "system", subtype: "init" });
  });
  it.each(["", "   ", "not json", "[1,2]", '"str"', "42", "null", '{"no":"type"}', '{"type":5}'])(
    "returns null for %j",
    (line) => {
      expect(parseStreamLine(line)).toBeNull();
    },
  );
});

describe("eventsOf", () => {
  it("turns the sample stream into ordered events", () => {
    const events = sample.flatMap((l) => eventsOf(parseStreamLine(l)!));
    expect(events.map((e) => e.kind)).toEqual([
      "init",
      "text",
      "tool_call",
      "tool_result",
      "text",
      "result",
    ]);
    expect(events[0]).toMatchObject({ sessionId: "sess-1", model: "claude-opus-5-5" });
    expect(events[2]).toEqual({
      kind: "tool_call",
      id: "toolu_1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(events[3]).toEqual({
      kind: "tool_result",
      id: "toolu_1",
      output: "a.txt\n",
      isError: false,
    });
  });

  it("joins array tool_result content and flags errors", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            is_error: true,
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
    };
    expect(eventsOf(msg)).toEqual([
      { kind: "tool_result", id: "t", output: "a\nb", isError: true },
    ]);
  });

  it("emits one event per content block and ignores unknown block and message types", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "x" },
          { type: "thinking", thinking: "..." },
          { type: "tool_use", id: "i", name: "Read", input: {} },
        ],
      },
    };
    expect(eventsOf(msg).map((e) => e.kind)).toEqual(["text", "tool_call"]);
    expect(eventsOf({ type: "stream_event", foo: 1 })).toEqual([]);
  });
});

describe("TurnCollector", () => {
  it("collects session, model, result text and Exo usage from a full run", () => {
    const c = new TurnCollector();
    for (const l of sample) c.feed(l);
    const o = c.outcome();
    expect(o).toMatchObject({
      sessionId: "sess-1",
      model: "claude-opus-5-5",
      resultText: "Done.",
      isError: false,
      badLines: 0,
    });
    expect(toExoUsage(o)).toEqual({
      model: "claude-opus-5-5",
      prompt_tokens: 1200 + 300 + 5000,
      completion_tokens: 210,
      prompt_cached_tokens: 5000,
      prompt_cache_creation_tokens: 300,
      completion_reasoning_tokens: 0,
      cost_usd: 0.0421,
      duration_ms: 4200,
    });
  });

  it("marks error results, and a stream without a result, as errors", () => {
    const failed = new TurnCollector();
    failed.feed(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s","num_turns":9}',
    );
    expect(failed.outcome()).toMatchObject({
      isError: true,
      subtype: "error_max_turns",
      sessionId: "s",
    });

    const none = new TurnCollector();
    none.feed(sample[0]!);
    expect(none.outcome()).toMatchObject({
      isError: true,
      errorReason: expect.stringMatching(/no result/i),
    });
    expect(toExoUsage(none.outcome())).toBeNull();
  });

  it("counts malformed lines without failing the turn", () => {
    const c = new TurnCollector();
    c.feed("garbage");
    c.feed("");
    for (const l of sample) c.feed(l);
    expect(c.outcome().badLines).toBe(1); // blank lines are not counted
    expect(c.outcome().isError).toBe(false);
  });

  it("reports usage without cost fields when the result has none", () => {
    const c = new TurnCollector();
    c.feed('{"type":"system","subtype":"init","session_id":"s","model":"m"}');
    c.feed(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":5,"output_tokens":2}}',
    );
    const u = toExoUsage(c.outcome())!;
    expect(u).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, prompt_cached_tokens: 0 });
    expect(u.cost_usd).toBeUndefined();
  });
});
