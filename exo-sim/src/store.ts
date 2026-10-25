// SQLite storage for the Exo simulator: agents, threads, turns, an append-only event log, pending
// human decisions and versioned artifacts. Everything a turn needs to continue after the process is
// killed lives here, which is what makes the simulator durable. WAL mode keeps committed rows
// across a SIGKILL.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Json = Record<string, unknown>;

export interface AgentRow {
  id: string;
  slug: string;
  body: Json;
}
export interface ThreadRow {
  id: string;
  agent_id: string;
  slug: string;
  name: string | null;
  environment: string | null;
  harness: string | null;
  model: unknown;
}
export interface TurnRow {
  id: string;
  thread_id: string;
  session_id: string;
  input: string;
  status: "running" | "completed" | "canceled" | "failed";
  frontend_tools: unknown[];
  auto_approve_tools: string[];
}
export interface EventRow extends Json {
  id: string;
  type: string;
  ts: string;
  thread_id: string;
  session_id: string | null;
  turn_id: string | null;
}
export interface PendingRow {
  id: string;
  kind: "approval" | "frontend";
  call_id: string;
  thread_id: string;
  turn_id: string;
  session_id: string;
  payload: Json;
  status: "pending" | "decided";
  decision: Json | null;
}
export interface EventQuery {
  session_id?: string;
  turn_id?: string;
  after?: string;
  limit?: number;
  direction?: "asc" | "desc";
  event_type?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, body_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, environment TEXT,
  harness TEXT, model_json TEXT, seq INTEGER NOT NULL, UNIQUE (agent_id, slug));
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, input TEXT NOT NULL,
  status TEXT NOT NULL, frontend_tools_json TEXT NOT NULL, auto_approve_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, session_id TEXT, turn_id TEXT,
  type TEXT NOT NULL, ts TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id, id);
CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, call_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL, session_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
  decision_json TEXT, UNIQUE (kind, call_id, thread_id));
CREATE TABLE IF NOT EXISTS artifacts (
  thread_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  call_id TEXT, PRIMARY KEY (thread_id, name, version));
`;

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private next(prefix: string): string {
    return this.db
      .transaction(() => {
        this.db.prepare("INSERT OR IGNORE INTO counters (kind, n) VALUES (?, 0)").run(prefix);
        this.db.prepare("UPDATE counters SET n = n + 1 WHERE kind = ?").run(prefix);
        const row = this.db.prepare("SELECT n FROM counters WHERE kind = ?").get(prefix) as {
          n: number;
        };
        return `${prefix}_${row.n}`;
      })
      .immediate();
  }

  // --- agents ---------------------------------------------------------------------------------

  createAgent(slug: string, body: Json): AgentRow {
    const id = this.next("agt");
    this.db
      .prepare("INSERT INTO agents (id, slug, body_json) VALUES (?, ?, ?)")
      .run(id, slug, JSON.stringify(body));
    return { id, slug, body };
  }

  agent(ref: string): AgentRow | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ? OR slug = ?").get(ref, ref) as
      { id: string; slug: string; body_json: string } | undefined;
    return r && { id: r.id, slug: r.slug, body: JSON.parse(r.body_json) };
  }

  listAgents(): AgentRow[] {
    return (
      this.db.prepare("SELECT * FROM agents ORDER BY rowid").all() as {
        id: string;
        slug: string;
        body_json: string;
      }[]
    ).map((r) => ({ id: r.id, slug: r.slug, body: JSON.parse(r.body_json) }));
  }

  updateAgent(id: string, body: Json): void {
    this.db.prepare("UPDATE agents SET body_json = ? WHERE id = ?").run(JSON.stringify(body), id);
  }

  // --- threads --------------------------------------------------------------------------------

  /** Creating a thread whose slug already exists returns that thread (so a retry is harmless). */
  createThread(
    agentId: string,
    t: { slug?: string; name?: string; environment?: string; harness?: string; model?: unknown },
  ): { thread: ThreadRow; created: boolean } {
    return this.db
      .transaction(() => {
        if (t.slug) {
          const existing = this.thread(agentId, t.slug);
          if (existing) return { thread: existing, created: false };
        }
        const id = this.next("thr");
        const slug = t.slug ?? id;
        const seq =
          (
            this.db
              .prepare("SELECT COUNT(*) AS n FROM threads WHERE agent_id = ?")
              .get(agentId) as { n: number }
          ).n + 1;
        this.db
          .prepare(
            "INSERT INTO threads (id, agent_id, slug, name, environment, harness, model_json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            agentId,
            slug,
            t.name ?? null,
            t.environment ?? null,
            t.harness ?? null,
            JSON.stringify(t.model ?? null),
            seq,
          );
        return { thread: this.thread(agentId, id)!, created: true };
      })
      .immediate();
  }

  thread(agentId: string, ref: string): ThreadRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM threads WHERE agent_id = ? AND (id = ? OR slug = ?)")
      .get(agentId, ref, ref) as Record<string, string | null> | undefined;
    return r && this.threadRow(r);
  }

  threadById(id: string): ThreadRow | undefined {
    const r = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      Record<string, string | null> | undefined;
    return r && this.threadRow(r);
  }

  private threadRow(r: Record<string, string | null>): ThreadRow {
    return {
      id: r.id!,
      agent_id: r.agent_id!,
      slug: r.slug!,
      name: r.name ?? null,
      environment: r.environment ?? null,
      harness: r.harness ?? null,
      model: r.model_json ? JSON.parse(r.model_json) : null,
    };
  }

  listThreads(
    agentId: string,
    cursor: number,
    limit: number,
  ): { threads: ThreadRow[]; next: number | null } {
    const rows = this.db
      .prepare("SELECT * FROM threads WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(agentId, cursor, limit + 1) as Record<string, string | null>[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1] as unknown as { seq: number } | undefined;
    return {
      threads: page.map((r) => this.threadRow(r)),
      next: rows.length > limit && last ? last.seq : null,
    };
  }

  // --- events ---------------------------------------------------------------------------------

  addEvent(
    threadId: string,
    e: { type: string; session_id?: string | null; turn_id?: string | null; payload?: Json },
  ): EventRow {
    const ts = new Date().toISOString();
    const info = this.db
      .prepare(
        "INSERT INTO events (thread_id, session_id, turn_id, type, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        threadId,
        e.session_id ?? null,
        e.turn_id ?? null,
        e.type,
        ts,
        JSON.stringify(e.payload ?? {}),
      );
    return {
      id: String(info.lastInsertRowid),
      type: e.type,
      ts,
      thread_id: threadId,
      session_id: e.session_id ?? null,
      turn_id: e.turn_id ?? null,
      ...(e.payload ?? {}),
    };
  }

  /** Runs related writes as one unit, so a kill between them cannot leave half of them behind. */
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /** Every event of a thread, oldest first, however many there are. */
  allEvents(threadId: string): EventRow[] {
    const out: EventRow[] = [];
    for (;;) {
      const page = this.events(threadId, {
        after: out.length ? out[out.length - 1]!.id : undefined,
        limit: 1000,
      });
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  events(threadId: string, q: EventQuery = {}): EventRow[] {
    const where = ["thread_id = ?"];
    const args: unknown[] = [threadId];
    const add = (clause: string, arg: unknown) => {
      where.push(clause);
      args.push(arg);
    };
    if (q.session_id) add("session_id = ?", q.session_id);
    if (q.turn_id) add("turn_id = ?", q.turn_id);
    if (q.event_type) add("type = ?", q.event_type);
    if (q.after) add(q.direction === "desc" ? "id < ?" : "id > ?", Number(q.after));
    const order = q.direction === "desc" ? "DESC" : "ASC";
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id ${order} LIMIT ?`)
      .all(...args, Math.max(1, Math.min(q.limit ?? 200, 1000))) as {
      id: number;
      type: string;
      ts: string;
      thread_id: string;
      session_id: string | null;
      turn_id: string | null;
      payload_json: string;
    }[];
    return rows.map((r) => ({
      id: String(r.id),
      type: r.type,
      ts: r.ts,
      thread_id: r.thread_id,
      session_id: r.session_id,
      turn_id: r.turn_id,
      ...JSON.parse(r.payload_json),
    }));
  }

  // --- turns ----------------------------------------------------------------------------------

  createTurn(t: {
    thread_id: string;
    session_id?: string;
    input: string;
    frontend_tools?: unknown[];
    auto_approve_tools?: string[];
  }): TurnRow {
    const id = this.next("trn");
    const session = t.session_id ?? this.next("ses");
    this.db
      .prepare(
        "INSERT INTO turns (id, thread_id, session_id, input, status, frontend_tools_json, auto_approve_json) VALUES (?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(
        id,
        t.thread_id,
        session,
        t.input,
        JSON.stringify(t.frontend_tools ?? []),
        JSON.stringify(t.auto_approve_tools ?? []),
      );
    return this.turn(id)!;
  }

  turn(id: string): TurnRow | undefined {
    const r = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as
      Record<string, string> | undefined;
    return (
      r && {
        id: r.id!,
        thread_id: r.thread_id!,
        session_id: r.session_id!,
        input: r.input!,
        status: r.status as TurnRow["status"],
        frontend_tools: JSON.parse(r.frontend_tools_json!),
        auto_approve_tools: JSON.parse(r.auto_approve_json!),
      }
    );
  }

  setTurnStatus(id: string, status: TurnRow["status"]): void {
    this.db.prepare("UPDATE turns SET status = ? WHERE id = ?").run(status, id);
  }

  activeTurn(threadId: string): TurnRow | undefined {
    const r = this.db
      .prepare(
        "SELECT id FROM turns WHERE thread_id = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1",
      )
      .get(threadId) as { id: string } | undefined;
    return r && this.turn(r.id);
  }

  runningTurns(): TurnRow[] {
    return (
      this.db.prepare("SELECT id FROM turns WHERE status = 'running' ORDER BY rowid").all() as {
        id: string;
      }[]
    ).map((r) => this.turn(r.id)!);
  }

  // --- pending human decisions ----------------------------------------------------------------

  /** Returns the pending item for (kind, call), creating it once; a resumed turn finds the same one. */
  ensurePending(
    kind: PendingRow["kind"],
    p: { call_id: string; thread_id: string; turn_id: string; session_id: string; payload: Json },
  ): { row: PendingRow; created: boolean } {
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare("SELECT * FROM pending WHERE kind = ? AND call_id = ? AND thread_id = ?")
          .get(kind, p.call_id, p.thread_id) as Record<string, string | null> | undefined;
        if (existing) return { row: this.pendingRow(existing), created: false };
        const id = this.next(kind === "approval" ? "apr" : "fe");
        this.db
          .prepare(
            "INSERT INTO pending (id, kind, call_id, thread_id, turn_id, session_id, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
          )
          .run(
            id,
            kind,
            p.call_id,
            p.thread_id,
            p.turn_id,
            p.session_id,
            JSON.stringify(p.payload),
          );
        return { row: this.pending(id)!, created: true };
      })
      .immediate();
  }

  pending(id: string): PendingRow | undefined {
    const r = this.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as
      Record<string, string | null> | undefined;
    return r && this.pendingRow(r);
  }

  pendingByCall(
    kind: PendingRow["kind"],
    threadId: string,
    callId: string,
  ): PendingRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM pending WHERE kind = ? AND call_id = ? AND thread_id = ?")
      .get(kind, callId, threadId) as Record<string, string | null> | undefined;
    return r && this.pendingRow(r);
  }

  decide(id: string, decision: Json): boolean {
    return (
      this.db
        .prepare(
          "UPDATE pending SET status = 'decided', decision_json = ? WHERE id = ? AND status = 'pending'",
        )
        .run(JSON.stringify(decision), id).changes === 1
    );
  }

  private pendingRow(r: Record<string, string | null>): PendingRow {
    return {
      id: r.id!,
      kind: r.kind as PendingRow["kind"],
      call_id: r.call_id!,
      thread_id: r.thread_id!,
      turn_id: r.turn_id!,
      session_id: r.session_id!,
      payload: JSON.parse(r.payload_json!),
      status: r.status as PendingRow["status"],
      decision: r.decision_json ? JSON.parse(r.decision_json) : null,
    };
  }

  // --- artifacts ------------------------------------------------------------------------------

  /** A new version per call; a repeated call id returns the version it already wrote. */
  writeArtifact(
    threadId: string,
    name: string,
    content: string,
    callId: string,
  ): { name: string; version: number; created: boolean } {
    return this.db
      .transaction(() => {
        const known = this.db
          .prepare("SELECT version FROM artifacts WHERE thread_id = ? AND name = ? AND call_id = ?")
          .get(threadId, name, callId) as { version: number } | undefined;
        if (known) return { name, version: known.version, created: false };
        const last = this.db
          .prepare("SELECT MAX(version) AS v FROM artifacts WHERE thread_id = ? AND name = ?")
          .get(threadId, name) as { v: number | null };
        const version = (last.v ?? 0) + 1;
        this.db
          .prepare(
            "INSERT INTO artifacts (thread_id, name, version, content, call_id) VALUES (?, ?, ?, ?, ?)",
          )
          .run(threadId, name, version, content, callId);
        return { name, version, created: true };
      })
      .immediate();
  }

  listArtifacts(threadId: string): { name: string; version: number; bytes: number }[] {
    return this.db
      .prepare(
        "SELECT name, version, LENGTH(CAST(content AS BLOB)) AS bytes FROM artifacts WHERE thread_id = ? ORDER BY name, version",
      )
      .all(threadId) as { name: string; version: number; bytes: number }[];
  }

  readArtifact(
    threadId: string,
    name: string,
    version?: number,
  ): { name: string; version: number; content: string } | undefined {
    const r = (
      version === undefined
        ? this.db
            .prepare(
              "SELECT name, version, content FROM artifacts WHERE thread_id = ? AND name = ? ORDER BY version DESC LIMIT 1",
            )
            .get(threadId, name)
        : this.db
            .prepare(
              "SELECT name, version, content FROM artifacts WHERE thread_id = ? AND name = ? AND version = ?",
            )
            .get(threadId, name, version)
    ) as { name: string; version: number; content: string } | undefined;
    return r;
  }

  /** Copies a thread's events and artifacts into a new thread (a fork at the head). */
  forkThread(agentId: string, sourceId: string, t: { slug?: string; name?: string }): ThreadRow {
    return this.db
      .transaction(() => {
        const source = this.threadById(sourceId)!;
        const { thread } = this.createThread(agentId, {
          slug: t.slug,
          name: t.name ?? `${source.name ?? source.slug} (fork)`,
          environment: source.environment ?? undefined,
          harness: source.harness ?? undefined,
          model: source.model,
        });
        const events = this.allEvents(sourceId);
        for (const e of events) {
          const { id: _id, type, ts: _ts, thread_id: _t, session_id, turn_id, ...payload } = e;
          this.addEvent(thread.id, { type, session_id, turn_id, payload });
        }
        this.db
          .prepare(
            "INSERT INTO artifacts (thread_id, name, version, content, call_id) SELECT ?, name, version, content, call_id FROM artifacts WHERE thread_id = ?",
          )
          .run(thread.id, sourceId);
        const head = events[events.length - 1];
        this.addEvent(thread.id, {
          type: "thread_forked",
          payload: { forked_from: sourceId, forked_at_event_id: head?.id ?? null },
        });
        return thread;
      })
      .immediate();
  }
}
