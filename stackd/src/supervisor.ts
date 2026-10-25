// The recovery supervisor (BUILD.md §4.9, FR-10). It probes Exo, and when Exo is back after being
// down it looks for turns that were cut off: a turn that is no longer active and never got a
// `turn_ended`. Such a turn gets at most EXOS_RECOVERY_MAX_ATTEMPTS continuation turns in a row;
// after that the thread is marked `failed_recovery`. It also owns the limit on active turns, cancels
// active turns when a pool reaches `stop` (if configured) and keeps the approvals queue current.
import {
  ExoHttpError,
  ExoProtocolError,
  ExoUnavailableError,
  type ExoClient,
} from "@exos/exo-client";
import { askUserDeclaration } from "@exos/tools/ask-user";
import { poolOf, type AgentDirectory, type AgentInfo } from "./agents.ts";
import type { ApprovalQueue } from "./approvals.ts";
import type { Pool } from "./context.ts";
import type { CreditGuard, Transition } from "./credit.ts";
import type { Db } from "./db/index.ts";
import { ApiError } from "./errors.ts";
import { listThreads } from "./threads.ts";

export interface SupervisorConfig {
  maxActiveTurns: number;
  recoveryMaxAttempts: number;
  /** After Exo comes back, wait this long before continuing turns, so Exo's own resume can win. */
  graceMs: number;
  /** Looks for cut-off turns at least this often even if Exo never went down. */
  recoverEveryMs: number;
  /** Refreshes the approvals queue at least this often. */
  syncEveryMs: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  maxActiveTurns: 4,
  recoveryMaxAttempts: 3,
  graceMs: 5_000,
  recoverEveryMs: 30_000,
  syncEveryMs: 5_000,
};

/** The prompt of a continuation turn: written here, never taken from the thread. */
export const CONTINUATION_PROMPT =
  "The previous turn was interrupted before it finished. Continue from where it stopped, and do not repeat steps that already completed.";

export type ExoState = "unknown" | "up" | "down";

export interface TrackedTurn {
  agentId: string;
  threadId: string;
  threadSlug: string;
  pool: Pool;
}

export interface SupervisorOptions {
  db: Db;
  exo: ExoClient;
  agents: AgentDirectory;
  credit: CreditGuard;
  approvals: ApprovalQueue;
  config?: Partial<SupervisorConfig>;
  clock?: () => Date;
  audit?: (action: string, target: string, details?: Record<string, unknown>) => void;
}

interface RecoveryRow {
  turn_id: string;
  attempts: number;
  outcome: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class Supervisor {
  readonly config: SupervisorConfig;
  private readonly clock: () => Date;
  private state: ExoState = "unknown";
  private upSince: number | undefined;
  private lastRecover = -Infinity;
  private recoverDue = false;
  private lastSync = -Infinity;
  private lastProbe: Date | undefined;
  private readonly tracked = new Map<string, TrackedTurn>();
  private ticking: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: SupervisorOptions) {
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...o.config };
    this.clock = o.clock ?? (() => new Date());
  }

  exoState(): ExoState {
    return this.state;
  }

  status() {
    return {
      exo_state: this.state,
      last_probe_at: this.lastProbe?.toISOString() ?? null,
      tracked_turns: this.tracked.size,
    };
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One probe, and whatever it makes due. Overlapping calls share the pass that is running. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  // --- active turns -----------------------------------------------------------------------

  track(turnId: string, turn: TrackedTurn): void {
    this.tracked.set(turnId, turn);
  }

  /** 429 `rate_limited` when EXOS_MAX_ACTIVE_TURNS turns started through the stack are still running. */
  async assertCapacity(): Promise<void> {
    await this.prune();
    if (this.tracked.size >= this.config.maxActiveTurns) {
      throw new ApiError(
        429,
        "rate_limited",
        "Too many active turns",
        `${this.tracked.size} turns are running; the limit is ${this.config.maxActiveTurns}`,
      );
    }
  }

  /** Forgets tracked turns that are no longer active in Exo. */
  private async prune(): Promise<void> {
    for (const [turnId, t] of [...this.tracked]) {
      try {
        if (!(await this.o.exo.getTurn(t.agentId, t.threadId, turnId)).active)
          this.tracked.delete(turnId);
      } catch (err) {
        if (err instanceof ExoHttpError && err.status === 404) this.tracked.delete(turnId);
        // Exo unreachable: keep it; the next probe decides
      }
    }
  }

  /** Called by the credit guard: in `stop`, cancels active turns of that pool if configured. */
  async onCredit(t: Transition): Promise<void> {
    if (t.to !== "stop" || !this.o.credit.config.cancelActive) return;
    for (const [turnId, tracked] of [...this.tracked]) {
      if (tracked.pool !== t.pool) continue;
      try {
        await this.o.exo.cancelTurn(tracked.agentId, tracked.threadId, turnId);
        this.o.audit?.("turn.cancel_on_credit_stop", tracked.threadSlug, {
          turn_id: turnId,
          pool: t.pool,
        });
        this.tracked.delete(turnId);
      } catch {
        // retried at the next transition or cancelled by hand; the audit log shows only successes
      }
    }
  }

  // --- the pass ---------------------------------------------------------------------------

  private async pass(): Promise<void> {
    const now = this.clock().getTime();
    const before = this.state;
    try {
      await this.o.agents.list(); // the probe, and it keeps the agent directory warm
      this.state = "up";
    } catch (err) {
      if (!(
        err instanceof ExoUnavailableError ||
        err instanceof ExoHttpError ||
        err instanceof ExoProtocolError
      )) {
        throw err;
      }
      this.state = "down";
    }
    this.lastProbe = this.clock();
    if (this.state === "down") {
      this.upSince = undefined;
      return;
    }
    if (before !== "up") {
      // first sight of Exo, or back after being down: look for cut-off turns once it has settled
      this.upSince = now;
      this.recoverDue = true;
    }

    if (now - this.lastSync >= this.config.syncEveryMs) {
      this.lastSync = now;
      await this.o.approvals.sync().catch(() => undefined);
    }
    const settled = now - (this.upSince ?? now) >= this.config.graceMs;
    if (settled && (this.recoverDue || now - this.lastRecover >= this.config.recoverEveryMs)) {
      this.recoverDue = false;
      this.lastRecover = now;
      await this.recoverAll();
    }
  }

  /** Looks at the newest turn of every thread: follows active ones, continues cut-off ones. */
  async recoverAll(): Promise<{ continued: number; failed: number }> {
    const out = { continued: 0, failed: 0 };
    for (const agent of await this.o.agents.list()) {
      for (const thread of await listThreads(this.o.exo, agent.id)) {
        const events = await this.o.exo.listEvents(agent.id, thread.id, {
          direction: "desc",
          limit: 100,
        });
        const started = events.find((e) => e.type === "turn_started");
        const turnId = started ? str((started as Record<string, unknown>).turn_id) : "";
        if (!started || !turnId) continue;
        if (
          events.some(
            (e) =>
              e.type === "turn_ended" && str((e as Record<string, unknown>).turn_id) === turnId,
          )
        )
          continue;

        let active: boolean;
        try {
          active = (await this.o.exo.getTurn(agent.id, thread.id, turnId)).active;
        } catch (err) {
          if (err instanceof ExoHttpError) continue;
          throw err;
        }
        if (active) {
          this.track(turnId, {
            agentId: agent.id,
            threadId: thread.id,
            threadSlug: thread.slug,
            pool: poolOf(agent),
          });
          continue;
        }
        const result = await this.recoverTurn(
          agent,
          thread,
          turnId,
          str((started as Record<string, unknown>).session_id),
        );
        if (result === "continued") out.continued++;
        if (result === "failed") out.failed++;
      }
    }
    return out;
  }

  private row(turnId: string): RecoveryRow | undefined {
    return this.o.db
      .prepare("SELECT turn_id, attempts, outcome FROM recoveries WHERE turn_id = ?")
      .get(turnId) as RecoveryRow | undefined;
  }

  /** Continuations already made in the chain that ends at this turn. */
  private chainAttempts(turnId: string): number {
    let attempts = 0;
    let current = turnId;
    for (let i = 0; i < 100; i++) {
      const parent = this.o.db
        .prepare("SELECT turn_id, attempts FROM recoveries WHERE outcome = ?")
        .get(`continued:${current}`) as { turn_id: string; attempts: number } | undefined;
      if (!parent) return attempts;
      attempts = Math.max(attempts, parent.attempts);
      current = parent.turn_id;
    }
    return attempts;
  }

  private async recoverTurn(
    agent: AgentInfo,
    thread: { id: string; slug: string },
    turnId: string,
    sessionId: string,
  ): Promise<"continued" | "failed" | "skipped"> {
    const { db, exo } = this.o;
    const existing = this.row(turnId);
    if (
      existing?.outcome &&
      (existing.outcome.startsWith("continued:") || existing.outcome === "failed_recovery")
    ) {
      return "skipped";
    }
    const done = Math.max(existing?.attempts ?? 0, this.chainAttempts(turnId));
    if (done >= this.config.recoveryMaxAttempts) {
      db.prepare(
        "INSERT INTO recoveries (turn_id, attempts, outcome) VALUES (?, ?, 'failed_recovery') ON CONFLICT (turn_id) DO UPDATE SET outcome = 'failed_recovery', attempts = excluded.attempts",
      ).run(turnId, done);
      this.o.audit?.("recovery.failed", thread.slug, { turn_id: turnId, attempts: done });
      return "failed";
    }

    try {
      this.o.credit.assertCanSpend(agent);
      await this.assertCapacity();
    } catch (err) {
      if (err instanceof ApiError) return "skipped"; // credit stop or full: try again at the next pass
      throw err;
    }

    try {
      const res = await exo.submitTurn(agent.id, thread.id, {
        input: CONTINUATION_PROMPT,
        ...(sessionId ? { session_id: sessionId } : {}),
        frontend_tools: [askUserDeclaration],
      });
      const turn = res.turn as string | { id: string };
      const newTurn = typeof turn === "string" ? turn : turn.id;
      db.prepare(
        "INSERT INTO recoveries (turn_id, attempts, outcome) VALUES (?, ?, ?) ON CONFLICT (turn_id) DO UPDATE SET attempts = excluded.attempts, outcome = excluded.outcome",
      ).run(turnId, done + 1, `continued:${newTurn}`);
      this.track(newTurn, {
        agentId: agent.id,
        threadId: thread.id,
        threadSlug: thread.slug,
        pool: poolOf(agent),
      });
      this.o.audit?.("recovery.continue", thread.slug, {
        turn_id: turnId,
        continuation_turn_id: newTurn,
        attempt: done + 1,
      });
      return "continued";
    } catch (err) {
      if (err instanceof ExoUnavailableError) return "skipped"; // does not count: Exo never saw it
      if (err instanceof ExoHttpError) {
        // Something else started a turn meanwhile (409), or Exo refused: record the try
        db.prepare(
          "INSERT INTO recoveries (turn_id, attempts, outcome) VALUES (?, ?, ?) ON CONFLICT (turn_id) DO UPDATE SET attempts = excluded.attempts, outcome = excluded.outcome",
        ).run(
          turnId,
          err.status === 409 ? done : done + 1,
          err.status === 409 ? "superseded" : null,
        );
        return "skipped";
      }
      throw err;
    }
  }

  /** What the recovery table says about a turn, for the thread status. */
  recoveryOutcome(turnId: string): "failed_recovery" | "interrupted" {
    return this.row(turnId)?.outcome === "failed_recovery" ? "failed_recovery" : "interrupted";
  }
}
