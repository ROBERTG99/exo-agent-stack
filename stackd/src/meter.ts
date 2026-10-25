// The usage meter (BUILD.md §4.8): reads `messages` events from Exo, prices them and stores one
// row per event. Exo stays the source of truth; this table only makes spend queryable and lets the
// credit guard refuse work before it starts. Turns started outside the stack are metered too.
import { usageOf, type ExoClient } from "@exos/exo-client";
import { listAgents, poolOf } from "./agents.ts";
import type { Pool } from "./context.ts";
import { cycleOf, type CycleConfig } from "./cycle.ts";
import type { Db } from "./db/index.ts";
import { costMicros, type RateTable } from "./pricing.ts";
import { listThreads } from "./threads.ts";

export interface MeterOptions {
  db: Db;
  exo: ExoClient;
  rates: RateTable;
  cycle: CycleConfig;
  clock?: () => Date;
  /** Called after rows were stored, once per (cycle, pool) that changed. */
  onIngested?: (touched: Array<{ cycle: string; pool: Pool }>) => void;
}

export interface IngestResult {
  ingested: number;
  threads: number;
  touched: Array<{ cycle: string; pool: Pool }>;
}

const PAGE = 200;

export class Meter {
  private readonly clock: () => Date;
  private running: Promise<IngestResult> | undefined;
  private lastSuccess: Date | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: MeterOptions) {
    this.clock = o.clock ?? (() => new Date());
  }

  /** Seconds since the last complete pass, or null before the first one. */
  lagSeconds(): number | null {
    return this.lastSuccess
      ? Math.max(0, Math.round((this.clock().getTime() - this.lastSuccess.getTime()) / 1000))
      : null;
  }

  start(intervalSeconds: number): void {
    this.stop();
    this.timer = setInterval(() => {
      this.ingestOnce().catch(() => undefined); // Exo down: the next tick tries again, lag grows
    }, intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every thread; overlapping calls share the pass that is already running. */
  ingestOnce(): Promise<IngestResult> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<IngestResult> {
    const { exo, db } = this.o;
    const result: IngestResult = { ingested: 0, threads: 0, touched: [] };
    const touched = new Map<string, { cycle: string; pool: Pool }>();

    for (const agent of await listAgents(exo)) {
      const pool = poolOf(agent);
      for (const thread of await listThreads(exo, agent.id)) {
        result.threads++;
        const cursorRow = db
          .prepare("SELECT last_event_id FROM meter_cursors WHERE thread_id = ?")
          .get(thread.id) as { last_event_id: string } | undefined;
        let cursor = cursorRow?.last_event_id;
        for (;;) {
          const page = await exo.listEvents(agent.id, thread.id, {
            event_type: "messages",
            after: cursor,
            limit: PAGE,
          });
          if (page.length === 0) break;
          db.transaction(() => {
            for (const event of page) {
              const usage = usageOf(event);
              if (!usage) continue;
              const at = Date.parse(String((event as Record<string, unknown>).ts ?? ""));
              const cycle = cycleOf(Number.isNaN(at) ? this.clock() : new Date(at), this.o.cycle);
              const cost = costMicros(usage, this.o.rates, pool);
              const inserted = db
                .prepare(
                  `INSERT OR IGNORE INTO usage_events
                   (event_id, agent_id, thread_id, turn_id, pool, model, prompt_tokens, completion_tokens,
                    cached_tokens, cache_creation_tokens, reasoning_tokens, cost_micros, cost_source, cycle)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  `${thread.id}:${event.id}`,
                  agent.id,
                  thread.id,
                  String((event as Record<string, unknown>).turn_id ?? ""),
                  pool,
                  usage.model,
                  usage.prompt_tokens,
                  usage.completion_tokens,
                  usage.prompt_cached_tokens,
                  usage.prompt_cache_creation_tokens,
                  usage.completion_reasoning_tokens,
                  cost.micros,
                  cost.source,
                  cycle,
                );
              if (inserted.changes === 1) {
                result.ingested++;
                touched.set(`${cycle}/${pool}`, { cycle, pool });
              }
            }
            cursor = page[page.length - 1]!.id;
            db.prepare(
              `INSERT INTO meter_cursors (thread_id, last_event_id) VALUES (?, ?)
               ON CONFLICT (thread_id) DO UPDATE SET last_event_id = excluded.last_event_id`,
            ).run(thread.id, cursor);
          })();
          if (page.length < PAGE) break;
        }
      }
    }
    result.touched = [...touched.values()];
    this.lastSuccess = this.clock();
    if (result.touched.length > 0) this.o.onIngested?.(result.touched);
    return result;
  }
}
