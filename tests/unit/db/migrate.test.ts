import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrate, openDatabase } from "@exos/stackd/db";
import { copyMigrations, freshDb, tempDir } from "./helpers.ts";

const tables = (db: ReturnType<typeof freshDb>["db"]) =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();

describe("migrate", () => {
  it("creates every table of the data model on a fresh database", () => {
    const { db } = freshDb();
    expect(tables(db)).toEqual(
      [
        "approvals",
        "audit_events",
        "credit_state",
        "idempotency",
        "meter_cursors",
        "recoveries",
        "schema_migrations",
        "usage_events",
        "worktrees",
      ].sort(),
    );
  });

  it("records the applied migration and is idempotent on the second run", () => {
    const { db } = freshDb();
    const rows = db.prepare("SELECT version, name FROM schema_migrations").all();
    expect(rows).toEqual([
      { version: 1, name: "init" },
      { version: 2, name: "worktree_base_commit" },
    ]);
    expect(migrate(db, defaultMigrationsDir())).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
  });

  it("uses WAL, foreign keys and a busy timeout", () => {
    const { db } = freshDb();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBeGreaterThanOrEqual(5000);
  });

  it("applies migrations in version order regardless of the order the files were created", () => {
    const dir = copyMigrations();
    writeFileSync(
      join(dir, "0004_child.sql"),
      "CREATE TABLE extra_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES extra_parent(id));",
    );
    writeFileSync(
      join(dir, "0003_parent.sql"),
      "CREATE TABLE extra_parent (id INTEGER PRIMARY KEY);",
    );
    const db = openDatabase(join(tempDir(), "stack.db"));
    expect(migrate(db, dir)).toEqual([1, 2, 3, 4]);
    expect(tables(db)).toEqual(expect.arrayContaining(["extra_parent", "extra_child"]));
  });

  it("rejects an edited migration that was already applied (checksum)", () => {
    const dir = copyMigrations();
    const db = openDatabase(join(tempDir(), "stack.db"));
    migrate(db, dir);
    appendFileSync(join(dir, "0001_init.sql"), "\n-- tampered\n");
    expect(() => migrate(db, dir)).toThrow(/checksum/i);
  });

  it("rolls a failing migration back completely and does not record it", () => {
    const dir = copyMigrations();
    writeFileSync(
      join(dir, "0003_bad.sql"),
      "CREATE TABLE half_done (id INTEGER); INSERT INTO table_that_does_not_exist VALUES (1);",
    );
    const db = openDatabase(join(tempDir(), "stack.db"));
    expect(() => migrate(db, dir)).toThrow(/table_that_does_not_exist/);
    expect(tables(db)).not.toContain("half_done");
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 2 });
  });

  it("rejects a gap or duplicate in migration numbering", () => {
    const dir = copyMigrations();
    writeFileSync(join(dir, "0004_gap.sql"), "SELECT 1;");
    const db = openDatabase(join(tempDir(), "stack.db"));
    expect(() => migrate(db, dir)).toThrow(/gap|missing/i);
    const dir2 = copyMigrations();
    writeFileSync(join(dir2, "0001_dup.sql"), "SELECT 1;");
    expect(() => migrate(openDatabase(join(tempDir(), "b.db")), dir2)).toThrow(/duplicate/i);
  });
});

describe("schema constraints (BUILD.md §4.4)", () => {
  it("restricts credit_state.state to ok, warn, stop", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      "INSERT INTO credit_state (cycle, pool, budget_micros, spent_micros, state, changed_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const state of ["ok", "warn", "stop"]) {
      insert.run("2026-10", `p-${state}`, 20_000_000, 0, state, "2026-10-01T00:00:00Z");
    }
    expect(() => insert.run("2026-10", "p-bad", 1, 0, "bogus", "t")).toThrow(/CHECK/i);
  });

  it("keys credit_state by (cycle, pool)", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      "INSERT INTO credit_state (cycle, pool, budget_micros, spent_micros, state, changed_at) VALUES ('2026-10', 'anthropic', 1, 0, 'ok', 't')",
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE|PRIMARY/i);
  });

  it("enforces the idempotency key length 8-128 and uniqueness", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      "INSERT INTO idempotency (key, args_sha256, status, response_json, created_at) VALUES (?, 'x', 'done', '{}', 't')",
    );
    expect(() => insert.run("short")).toThrow(/CHECK/i);
    expect(() => insert.run("k".repeat(129))).toThrow(/CHECK/i);
    insert.run("k".repeat(8));
    insert.run("k".repeat(128));
    expect(() => insert.run("k".repeat(8))).toThrow(/UNIQUE|PRIMARY/i);
  });

  it("deduplicates usage events by event_id with INSERT OR IGNORE and stores integer micro-dollars", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO usage_events
         (event_id, agent_id, thread_id, turn_id, pool, model, prompt_tokens, completion_tokens,
          cached_tokens, cache_creation_tokens, reasoning_tokens, cost_micros, cost_source, cycle)
       VALUES (?, 'a', 't', 'u', 'anthropic', 'm', 1, 2, 0, 0, 0, ?, 'exo', '2026-10')`,
    );
    expect(insert.run("evt-1", 1_234_567).changes).toBe(1);
    expect(insert.run("evt-1", 999).changes).toBe(0);
    expect(
      db.prepare("SELECT cost_micros, typeof(cost_micros) AS t FROM usage_events").get(),
    ).toEqual({
      cost_micros: 1_234_567,
      t: "integer",
    });
  });

  it("rejects a fractional cost and an unknown cost_source", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      `INSERT INTO usage_events
         (event_id, agent_id, thread_id, turn_id, pool, model, prompt_tokens, completion_tokens,
          cached_tokens, cache_creation_tokens, reasoning_tokens, cost_micros, cost_source, cycle)
       VALUES ('e', 'a', 't', 'u', 'anthropic', 'm', 0, 0, 0, 0, 0, ?, ?, '2026-10')`,
    );
    expect(() => insert.run(1.5, "exo")).toThrow(/CHECK|datatype/i);
    expect(() => insert.run(1, "guess")).toThrow(/CHECK/i);
    expect(() => insert.run(-1, "exo")).toThrow(/CHECK/i);
  });

  it("makes worktree_path unique across threads", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      "INSERT INTO worktrees (thread_slug, repo_path, worktree_path, branch) VALUES (?, '/r', ?, 'b')",
    );
    insert.run("d-1", "/w/one");
    expect(() => insert.run("d-2", "/w/one")).toThrow(/UNIQUE/i);
  });

  it("indexes usage_events by (cycle, pool) and approvals by decision", () => {
    const { db } = freshDb();
    const idx = (table: string) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);
    const cols = (name: string) =>
      (db.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[]).map((r) => r.name);
    const usageIdx = idx("usage_events").find((n) => !n.startsWith("sqlite_autoindex"));
    expect(cols(usageIdx!)).toEqual(["cycle", "pool"]);
    const apprIdx = idx("approvals").find((n) => !n.startsWith("sqlite_autoindex"));
    expect(cols(apprIdx!)).toEqual(["decision"]);
  });

  it("allows only the documented approval decisions", () => {
    const { db } = freshDb();
    const insert = db.prepare(
      `INSERT INTO approvals (approval_id, kind, thread_id, turn_id, session_id, tool, args_redacted, decision, decided_by)
       VALUES (?, 'tool', 't', 'u', 's', 'claude.Bash', '{}', ?, NULL)`,
    );
    for (const d of ["pending", "approved", "denied", "approved_for_session", "dashboard_only"]) {
      insert.run(`a-${d}`, d);
    }
    expect(() => insert.run("a-bad", "maybe")).toThrow(/CHECK/i);
  });
});
