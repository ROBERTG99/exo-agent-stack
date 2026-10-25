// What every stackd route needs, built once in buildStackd and passed down.
import type { ExoClient } from "@exos/exo-client";
import type { AgentDirectory, AgentInfo } from "./agents.ts";
import type { CreditGuard } from "./credit.ts";
import type { Meter } from "./meter.ts";
import type { Db } from "./db/index.ts";
import type { Idempotency } from "./idempotency.ts";
import type { WorktreeManager } from "./worktrees.ts";

export type CreditState = "ok" | "warn" | "stop";
export type Pool = "anthropic" | "cursor" | "local";

/** What the routes need from the credit guard. */
export interface CreditGate {
  /** Throws a 402 `credit_stop` ApiError when spending in the agent's pool is stopped. */
  assertCanSpend(agent: Pick<AgentInfo, "slug" | "mode">): void;
  state(pool: Pool): CreditState;
}

export interface AppContext {
  db: Db;
  exo: ExoClient;
  idem: Idempotency;
  worktrees: WorktreeManager;
  credit: CreditGuard;
  meter: Meter;
  agents: AgentDirectory;
  clock: () => Date;
  /** Where the dashboard lives, for links in responses. */
  dashboardUrl: string;
  /** Appends a hash-chained audit event (every stackd write does). */
  audit(action: string, target: string, details?: Record<string, unknown>, actor?: string): void;
}
