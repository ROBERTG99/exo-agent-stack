import { ExoHttpError, ExoUnavailableError } from "@exos/exo-client";
import { describe, expect, it } from "vitest";
import { AgentDirectory } from "../../stackd/src/agents.ts";
import { ApiError } from "../../stackd/src/errors.ts";
import { CONTINUATION_PROMPT, Supervisor } from "../../stackd/src/supervisor.ts";
import { freshDb } from "./db/helpers.ts";

type Ev = Record<string, unknown> & { id: string; type: string };

/** An Exo with one agent and the given threads. `active` says which turns are still running. */
function fakeExo(threads: Record<string, Ev[]>, harness = "../harnesses/claude-host/harness.ts") {
  const state = {
    down: false,
    active: new Set<string>(),
    submitted: [] as Array<{ thread: string; body: Record<string, unknown> }>,
    cancelled: [] as string[],
    submitError: undefined as unknown,
    getTurnError: undefined as unknown,
    nextTurn: 100,
  };
  const guard = () => {
    if (state.down) throw new ExoUnavailableError("down", 1);
  };
  const exo = {
    listAgents: async () => {
      guard();
      return [{ id: "agt_1", slug: "a", name: "a", harness }];
    },
    listThreads: async () => {
      guard();
      return { threads: Object.keys(threads).map((id) => ({ id, slug: id })), next_cursor: null };
    },
    listEvents: async (_a: string, thread: string, q: { direction?: string; limit?: number }) => {
      guard();
      const all = [...(threads[thread] ?? [])];
      return (q.direction === "desc" ? all.reverse() : all).slice(0, q.limit ?? 200);
    },
    getTurn: async (_a: string, _t: string, turn: string) => {
      guard();
      if (state.getTurnError) throw state.getTurnError;
      return { active: state.active.has(turn) };
    },
    submitTurn: async (_a: string, thread: string, body: Record<string, unknown>) => {
      guard();
      if (state.submitError) throw state.submitError;
      const id = `trn_${state.nextTurn++}`;
      state.submitted.push({ thread, body });
      state.active.add(id);
      return { turn: { id, session_id: String(body.session_id ?? "ses_new") } };
    },
    cancelTurn: async (_a: string, _t: string, turn: string) => {
      guard();
      state.cancelled.push(turn);
      state.active.delete(turn);
      return { canceled_active_turn: true };
    },
  };
  return { exo: exo as never, state };
}

const started = (turn: string, session = "ses_1", n = turn): Ev => ({
  id: `s-${n}`,
  type: "turn_started",
  turn_id: turn,
  session_id: session,
});
const ended = (turn: string): Ev => ({ id: `e-${turn}`, type: "turn_ended", turn_id: turn });

function setup(
  threads: Record<string, Ev[]>,
  over: {
    cfg?: Record<string, unknown>;
    credit?: { assert?: () => void; cancelActive?: boolean };
    harness?: string;
  } = {},
) {
  const { exo, state } = fakeExo(threads, over.harness);
  const { db } = freshDb();
  let now = new Date("2026-10-25T10:00:00Z");
  const synced: number[] = [];
  const audits: string[] = [];
  const supervisor = new Supervisor({
    db,
    exo,
    agents: new AgentDirectory(exo),
    credit: {
      assertCanSpend: over.credit?.assert ?? (() => undefined),
      config: { cancelActive: over.credit?.cancelActive ?? false },
    } as never,
    approvals: { sync: async () => void synced.push(now.getTime()) } as never,
    config: { graceMs: 5_000, recoverEveryMs: 30_000, syncEveryMs: 5_000, ...over.cfg },
    clock: () => now,
    audit: (action) => void audits.push(action),
  });
  return {
    supervisor,
    state,
    db,
    synced,
    audits,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("active turn limit", () => {
  const tracked = (n: number) => ({
    agentId: "agt_1",
    threadId: "thr_1",
    threadSlug: "t",
    pool: "anthropic" as const,
    n,
  });

  it("refuses with 429 rate_limited when the limit of running turns is reached", async () => {
    const { supervisor, state } = setup({}, { cfg: { maxActiveTurns: 2 } });
    for (const t of ["trn_1", "trn_2"]) {
      state.active.add(t);
      supervisor.track(t, tracked(0));
    }
    await expect(supervisor.assertCapacity()).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });

  it("frees a slot when a tracked turn is no longer active, or gone", async () => {
    const { supervisor, state } = setup({}, { cfg: { maxActiveTurns: 2 } });
    supervisor.track("trn_1", tracked(0));
    supervisor.track("trn_2", tracked(0));
    state.active.add("trn_1");
    await expect(supervisor.assertCapacity()).resolves.toBeUndefined(); // trn_2 is not active
    expect(supervisor.status().tracked_turns).toBe(1);
    state.getTurnError = new ExoHttpError(404, {}, "/turn");
    await supervisor.assertCapacity();
    expect(supervisor.status().tracked_turns).toBe(0);
  });

  it("keeps a turn it cannot check while Exo is unreachable", async () => {
    const { supervisor, state } = setup({}, { cfg: { maxActiveTurns: 1 } });
    supervisor.track("trn_1", tracked(0));
    state.getTurnError = new ExoUnavailableError("down", 1);
    await expect(supervisor.assertCapacity()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("recoverAll", () => {
  it("continues a turn that was cut off, once, in the same session", async () => {
    const { supervisor, state, db, audits } = setup({ thr_1: [started("trn_1", "ses_7")] });
    expect(await supervisor.recoverAll()).toEqual({ continued: 1, failed: 0 });
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0]).toMatchObject({
      thread: "thr_1",
      body: { input: CONTINUATION_PROMPT, session_id: "ses_7" },
    });
    expect((state.submitted[0]!.body.frontend_tools as Array<{ name: string }>)[0]!.name).toBe(
      "ask_user",
    );
    expect(db.prepare("SELECT * FROM recoveries").all()).toEqual([
      { turn_id: "trn_1", attempts: 1, outcome: "continued:trn_100" },
    ]);
    expect(audits).toContain("recovery.continue");
    // the continuation is running now, and nothing more happens
    expect(await supervisor.recoverAll()).toEqual({ continued: 0, failed: 0 });
    expect(state.submitted).toHaveLength(1);
  });

  it("leaves running turns and finished turns alone, and follows the running ones", async () => {
    const { supervisor, state } = setup({
      thr_1: [started("trn_1")],
      thr_2: [started("trn_2"), ended("trn_2")],
    });
    state.active.add("trn_1");
    expect(await supervisor.recoverAll()).toEqual({ continued: 0, failed: 0 });
    expect(state.submitted).toEqual([]);
    expect(supervisor.status().tracked_turns).toBe(1);
  });

  it("looks only at the newest turn of a thread", async () => {
    const { supervisor, state } = setup({
      thr_1: [started("trn_1"), ended("trn_1"), started("trn_2")],
    });
    await supervisor.recoverAll();
    expect(state.submitted).toHaveLength(1);
    expect(supervisor.recoveryOutcome("trn_2")).toBe("interrupted");
  });

  it("gives up after the configured number of continuations in a chain", async () => {
    const threads: Record<string, Ev[]> = { thr_1: [started("trn_1")] };
    const { supervisor, state, audits } = setup(threads, { cfg: { recoveryMaxAttempts: 3 } });
    const cutOffAgain = async (turn: string, next: string) => {
      state.active.delete(turn);
      threads.thr_1!.push(started(next));
      return supervisor.recoverAll();
    };
    expect(await supervisor.recoverAll()).toMatchObject({ continued: 1 }); // trn_1 → trn_100
    expect(await cutOffAgain("trn_100", "trn_100")).toMatchObject({ continued: 1 }); // → trn_101
    expect(await cutOffAgain("trn_101", "trn_101")).toMatchObject({ continued: 1 }); // → trn_102 (third)
    expect(await cutOffAgain("trn_102", "trn_102")).toEqual({ continued: 0, failed: 1 });
    expect(state.submitted).toHaveLength(3);
    expect(supervisor.recoveryOutcome("trn_102")).toBe("failed_recovery");
    expect(audits).toContain("recovery.failed");
    expect(await supervisor.recoverAll()).toEqual({ continued: 0, failed: 0 }); // does not repeat
  });

  it("does not continue while the pool is at credit stop, and does later", async () => {
    let stopped = true;
    const { supervisor, state, db } = setup(
      { thr_1: [started("trn_1")] },
      {
        credit: {
          assert: () => {
            if (stopped) throw new ApiError(402, "credit_stop", "Credit stop");
          },
        },
      },
    );
    expect(await supervisor.recoverAll()).toEqual({ continued: 0, failed: 0 });
    expect(state.submitted).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recoveries").get()).toEqual({ n: 0 });
    stopped = false;
    expect(await supervisor.recoverAll()).toMatchObject({ continued: 1 });
  });

  it("does not count an attempt Exo never saw, but counts one it refused", async () => {
    const { supervisor, state, db } = setup({ thr_1: [started("trn_1")] });
    state.submitError = new ExoUnavailableError("down", 1);
    await supervisor.recoverAll();
    expect(db.prepare("SELECT COUNT(*) AS n FROM recoveries").get()).toEqual({ n: 0 });
    state.submitError = new ExoHttpError(500, {}, "/turn");
    await supervisor.recoverAll();
    expect(db.prepare("SELECT attempts, outcome FROM recoveries").get()).toEqual({
      attempts: 1,
      outcome: null,
    });
    state.submitError = undefined;
    await supervisor.recoverAll();
    expect(db.prepare("SELECT attempts, outcome FROM recoveries").get()).toEqual({
      attempts: 2,
      outcome: "continued:trn_100",
    });
  });

  it("marks a turn superseded when something else already started a new one (409)", async () => {
    const { supervisor, state, db } = setup({ thr_1: [started("trn_1")] });
    state.submitError = new ExoHttpError(409, { error: { code: "turn_active" } }, "/turn");
    await supervisor.recoverAll();
    expect(db.prepare("SELECT attempts, outcome FROM recoveries").get()).toEqual({
      attempts: 0,
      outcome: "superseded",
    });
  });

  it("respects the limit on active turns", async () => {
    const { supervisor, state } = setup(
      { thr_1: [started("trn_1")] },
      { cfg: { maxActiveTurns: 1 } },
    );
    state.active.add("busy");
    supervisor.track("busy", {
      agentId: "agt_1",
      threadId: "thr_x",
      threadSlug: "x",
      pool: "anthropic",
    });
    expect(await supervisor.recoverAll()).toEqual({ continued: 0, failed: 0 });
    expect(state.submitted).toEqual([]);
  });
});

describe("tick", () => {
  it("reports Exo as down, does nothing else, and recovers after the grace period once it is back", async () => {
    const { supervisor, state, advance, synced } = setup({ thr_1: [started("trn_1")] });
    state.down = true;
    await supervisor.tick();
    expect(supervisor.exoState()).toBe("down");
    expect(supervisor.status().last_probe_at).not.toBeNull();
    expect(synced).toEqual([]);

    state.down = false;
    advance(1_000);
    await supervisor.tick();
    expect(supervisor.exoState()).toBe("up");
    expect(state.submitted).toEqual([]); // Exo's own resume gets the grace period first
    advance(2_000);
    await supervisor.tick();
    expect(state.submitted).toEqual([]);
    advance(3_000);
    await supervisor.tick();
    expect(state.submitted).toHaveLength(1);
    advance(1_000);
    await supervisor.tick();
    expect(state.submitted).toHaveLength(1); // not again
  });

  it("looks again on its own schedule even if Exo never went down", async () => {
    const threads: Record<string, Ev[]> = { thr_1: [] };
    const { supervisor, state, advance } = setup(threads, {
      cfg: { graceMs: 0, recoverEveryMs: 10_000 },
    });
    await supervisor.tick(); // first sight
    threads.thr_1!.push(started("trn_1"));
    advance(5_000);
    await supervisor.tick();
    expect(state.submitted).toHaveLength(0);
    advance(5_000);
    await supervisor.tick();
    expect(state.submitted).toHaveLength(1);
  });

  it("refreshes the approvals queue on its interval", async () => {
    const { supervisor, advance, synced } = setup({}, { cfg: { graceMs: 0, syncEveryMs: 5_000 } });
    await supervisor.tick();
    advance(2_000);
    await supervisor.tick();
    advance(3_000);
    await supervisor.tick();
    expect(synced).toHaveLength(2);
  });

  it("shares one pass between overlapping ticks and does not swallow a real bug", async () => {
    const { supervisor } = setup({});
    expect(supervisor.tick()).toBe(supervisor.tick());
    await supervisor.tick();
  });
});

describe("cancelling on credit stop", () => {
  const stop = {
    pool: "anthropic" as const,
    cycle: "2026-10",
    from: "warn" as const,
    to: "stop" as const,
    spent_micros: 1,
    budget_micros: 1,
  };
  const track = (
    s: Supervisor,
    state: ReturnType<typeof setup>["state"],
    turn: string,
    pool: "anthropic" | "cursor",
  ) => {
    state.active.add(turn);
    s.track(turn, { agentId: "agt_1", threadId: "thr_1", threadSlug: "t", pool });
  };

  it("cancels the active turns of the stopped pool only, when configured", async () => {
    const { supervisor, state, audits } = setup({}, { credit: { cancelActive: true } });
    track(supervisor, state, "trn_a", "anthropic");
    track(supervisor, state, "trn_c", "cursor");
    await supervisor.onCredit(stop);
    expect(state.cancelled).toEqual(["trn_a"]);
    expect(audits).toContain("turn.cancel_on_credit_stop");
    expect(supervisor.status().tracked_turns).toBe(1);
  });

  it("does nothing when cancelling is off, or the state is only warn", async () => {
    const off = setup({}, { credit: { cancelActive: false } });
    track(off.supervisor, off.state, "trn_a", "anthropic");
    await off.supervisor.onCredit(stop);
    expect(off.state.cancelled).toEqual([]);
    const warn = setup({}, { credit: { cancelActive: true } });
    track(warn.supervisor, warn.state, "trn_a", "anthropic");
    await warn.supervisor.onCredit({ ...stop, to: "warn" });
    expect(warn.state.cancelled).toEqual([]);
  });
});
