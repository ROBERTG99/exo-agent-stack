// Runs one turn the way a durable Exo harness would: the conversation is rebuilt from the event
// log, every tool call is recorded before and after it runs, human decisions are stored rows that a
// restarted process finds again, and an unfinished turn is simply run again (resumeTurn) so that
// the scripted loop picks up where the log ends. The model is the fake model server.
import { appendLedger } from "@exos/scripted-harness/ledger";
import {
  runScriptedTurn,
  type InputItem,
  type ModelOutput,
  type ToolCall,
  type TurnPorts,
} from "@exos/scripted-harness/turn";
import type { EventRow, Store, TurnRow } from "./store.ts";

export interface RunnerOptions {
  store: Store;
  /** Base URL of the model server (the fake model): POST {modelUrl}/v1/responses. */
  modelUrl: string;
  /** Pause before every model call, so a test can kill the process in the middle of a turn. */
  stepDelayMs?: number;
  /** Where the test-only ledger_append tool writes. */
  ledgerPath?: string;
  /** How often waiting turns look at stored decisions. */
  pollMs?: number;
  fetch?: typeof fetch;
}

class Aborted extends Error {
  constructor(readonly reason: "cancel" | "crash") {
    super(reason);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The simulator's price list: only used to fill `cost_usd`, never a real rate. */
const costUsd = (input: number, output: number): number =>
  Math.round(input * 15 + output * 75) / 1_000_000;

export class TurnRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly finished = new Map<string, Promise<void>>();

  constructor(private readonly o: RunnerOptions) {}

  /** Starts (or resumes) a turn in the background. Starting a turn that is already running does nothing. */
  start(turn: TurnRow): void {
    if (this.controllers.has(turn.id)) return;
    const controller = new AbortController();
    this.controllers.set(turn.id, controller);
    const promise = this.run(turn, controller.signal).finally(() =>
      this.controllers.delete(turn.id),
    );
    this.finished.set(turn.id, promise);
  }

  /** Resumes every turn the log still shows as running (after a restart). */
  recover(): void {
    for (const turn of this.o.store.runningTurns()) this.start(turn);
  }

  isRunning(turnId: string): boolean {
    return this.controllers.has(turnId);
  }

  async cancel(turnId: string): Promise<boolean> {
    const controller = this.controllers.get(turnId);
    if (!controller) return false;
    controller.abort(new Aborted("cancel"));
    await this.finished.get(turnId);
    return true;
  }

  /** Stops every runner without writing anything, like a SIGKILL would (for in-process tests). */
  crash(): void {
    for (const c of this.controllers.values()) c.abort(new Aborted("crash"));
  }

  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.finished.values()]);
  }

  // --- one turn -------------------------------------------------------------------------------

  private async run(turn: TurnRow, signal: AbortSignal): Promise<void> {
    const { store } = this.o;
    const finish = (status: "completed" | "canceled" | "failed") => {
      store.setTurnStatus(turn.id, status);
      store.addEvent(turn.thread_id, {
        type: "turn_ended",
        session_id: turn.session_id,
        turn_id: turn.id,
        payload: { status },
      });
    };
    try {
      await runScriptedTurn(this.ports(turn, signal));
      finish("completed");
    } catch (err) {
      const reason = signal.reason instanceof Aborted ? signal.reason.reason : undefined;
      if (err instanceof Aborted || reason) {
        if ((err instanceof Aborted ? err.reason : reason) === "cancel") finish("canceled");
        return; // a crash leaves the log exactly as it was
      }
      store.addEvent(turn.thread_id, {
        type: "error",
        session_id: turn.session_id,
        turn_id: turn.id,
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
      finish("failed");
    }
  }

  private ports(turn: TurnRow, signal: AbortSignal): TurnPorts {
    const { store } = this.o;
    const emit = (type: string, payload: Record<string, unknown> = {}) =>
      store.addEvent(turn.thread_id, {
        type,
        session_id: turn.session_id,
        turn_id: turn.id,
        payload,
      });
    const check = () => {
      if (signal.aborted)
        throw signal.reason instanceof Aborted ? signal.reason : new Aborted("crash");
    };
    const hasEvent = (type: string, callId: string): boolean =>
      store.db
        .prepare(
          "SELECT 1 FROM events WHERE thread_id = ? AND type = ? AND json_extract(payload_json, '$.call_id') = ? LIMIT 1",
        )
        .get(turn.thread_id, type, callId) !== undefined;

    return {
      maxRoundTrips: 256,
      conversation: async () => {
        check();
        return conversationOf(store.events(turn.thread_id, { limit: 1000 }));
      },
      callModel: async (input) => {
        check();
        if (this.o.stepDelayMs) await sleep(this.o.stepDelayMs);
        check();
        const out = await this.model(input, signal);
        check();
        return out;
      },
      existingResult: async (callId) => {
        check();
        const row = store.db
          .prepare(
            "SELECT json_extract(payload_json, '$.output') AS output FROM events WHERE thread_id = ? AND type = 'tool_result' AND json_extract(payload_json, '$.call_id') = ? LIMIT 1",
          )
          .get(turn.thread_id, callId) as { output: string } | undefined;
        return row?.output;
      },
      recordToolCall: async (call) => {
        check();
        if (!hasEvent("tool_requested", call.id))
          emit("tool_requested", { call_id: call.id, name: call.name, arguments: call.args });
      },
      runTool: async (call) => {
        check();
        return this.tool(turn, call, signal, emit);
      },
      recordResult: async (call, output) => {
        check();
        emit("tool_result", { call_id: call.id, name: call.name, output });
      },
      emitText: async (text) => {
        check();
        emit("messages", { role: "assistant", text });
      },
      recordUsage: async (u) => {
        check();
        emit("messages", {
          role: "assistant",
          usage: {
            model: "fake-model",
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            prompt_cached_tokens: 0,
            prompt_cache_creation_tokens: 0,
            completion_reasoning_tokens: 0,
            cost_usd: costUsd(u.input_tokens, u.output_tokens),
            duration_ms: 1,
          },
        });
      },
    };
  }

  private async model(input: InputItem[], signal: AbortSignal): Promise<ModelOutput> {
    const doFetch = this.o.fetch ?? fetch;
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(100 * attempt);
      try {
        const res = await doFetch(`${this.o.modelUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fake-model", input }),
          signal,
        });
        if (res.status === 429 || res.status >= 500) {
          last = new Error(`model answered ${res.status}`);
          continue;
        }
        if (!res.ok)
          throw new Error(`model answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return (await res.json()) as ModelOutput;
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof Error && /^model answered 4/.test(err.message)) throw err;
        last = err;
      }
    }
    throw new Error(`the model is unavailable: ${(last as Error)?.message ?? "unknown error"}`);
  }

  private async tool(
    turn: TurnRow,
    call: ToolCall,
    signal: AbortSignal,
    emit: (t: string, p?: Record<string, unknown>) => EventRow,
  ): Promise<string> {
    const { store } = this.o;
    switch (call.name) {
      case "ledger_append": {
        if (!this.o.ledgerPath) throw new Error("no ledger configured (EXOS_TEST_LEDGER)");
        return JSON.stringify(
          appendLedger(this.o.ledgerPath, { tool_call_id: call.id, seq: Number(call.args.seq) }),
        );
      }
      case "write_report": {
        const w = store.writeArtifact(
          turn.thread_id,
          String(call.args.name),
          String(call.args.content ?? ""),
          call.id,
        );
        if (w.created)
          emit("artifact_written", { name: w.name, version: w.version, call_id: call.id });
        return JSON.stringify({ name: w.name, version: w.version });
      }
      case "run_checks":
        return JSON.stringify({
          exit_code: 0,
          duration_ms: 1,
          summary: "simulated: all checks passed",
        });
      case "authorize": {
        const tool = String(call.args.name);
        if (turn.auto_approve_tools.includes(tool))
          return JSON.stringify({ approved: true, auto: true });
        const { row, created } = store.ensurePending("approval", {
          call_id: call.id,
          thread_id: turn.thread_id,
          turn_id: turn.id,
          session_id: turn.session_id,
          payload: { tool, arguments: call.args.arguments ?? {} },
        });
        if (created)
          emit("agent_runtime.approval_requested", {
            approval_id: row.id,
            tool,
            arguments: call.args.arguments ?? {},
            call_id: call.id,
          });
        const decided = await this.waitDecided(row.id, signal);
        return JSON.stringify({ approved: decided.decision?.approved === true });
      }
      case "ask_user": {
        if (!turn.frontend_tools.some((t) => (t as { name?: string })?.name === "ask_user")) {
          throw new Error("ask_user is not available in this turn (no frontend tool was declared)");
        }
        const { row, created } = store.ensurePending("frontend", {
          call_id: call.id,
          thread_id: turn.thread_id,
          turn_id: turn.id,
          session_id: turn.session_id,
          payload: { tool: "ask_user", arguments: call.args },
        });
        if (created)
          emit("frontend_tool_requested", {
            tool_call_id: call.id,
            call_id: call.id,
            name: "ask_user",
            arguments: call.args,
          });
        const decided = await this.waitDecided(row.id, signal);
        return String(decided.decision?.output ?? "");
      }
      default:
        throw new Error(`unknown tool ${call.name}`);
    }
  }

  private async waitDecided(id: string, signal: AbortSignal) {
    for (;;) {
      if (signal.aborted)
        throw signal.reason instanceof Aborted ? signal.reason : new Aborted("crash");
      const p = this.o.store.pending(id);
      if (p?.status === "decided") return p;
      await sleep(this.o.pollMs ?? 20);
    }
  }
}

/** Rebuilds the model's conversation from a thread's events. */
export function conversationOf(events: EventRow[]): InputItem[] {
  const items: InputItem[] = [];
  for (const e of events) {
    if (e.type === "messages" && e.role === "user" && typeof e.text === "string") {
      items.push({ role: "user", content: [{ type: "input_text", text: e.text }] });
    } else if (e.type === "messages" && e.role === "assistant" && typeof e.text === "string") {
      items.push({ role: "assistant", content: [{ type: "output_text", text: e.text }] });
    } else if (e.type === "tool_requested") {
      items.push({
        type: "function_call",
        call_id: String(e.call_id),
        name: String(e.name),
        arguments: JSON.stringify(e.arguments ?? {}),
      });
    } else if (e.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: String(e.call_id),
        output: String(e.output ?? ""),
      });
    }
  }
  return items;
}
