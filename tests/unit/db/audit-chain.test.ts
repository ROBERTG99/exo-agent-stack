import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  appendAudit,
  computeAuditHash,
  defaultMigrationsDir,
  migrate,
  openDatabase,
  verifyAuditChain,
} from "@exos/stackd/db";
import { freshDb, tempDir } from "./helpers.ts";
import { join } from "node:path";

const clock = () => new Date("2026-10-25T12:00:00.000Z");

describe("audit chain", () => {
  it("starts from the genesis hash and links every event to the previous one", () => {
    const { db } = freshDb();
    const a = appendAudit(
      db,
      { actor: "owner", action: "thread.start", target: "t1", details: { n: 1 } },
      clock,
    );
    const b = appendAudit(
      db,
      { actor: "owner", action: "thread.send", target: "t1", details: {} },
      clock,
    );
    const c = appendAudit(
      db,
      { actor: "system", action: "credit.warn", target: "anthropic", details: { spent: 14 } },
      clock,
    );
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(b.prev_hash).toBe(a.hash);
    expect(c.prev_hash).toBe(b.hash);
    expect(a.ts).toBe("2026-10-25T12:00:00.000Z");
  });

  it("computes each hash from the canonical event content", () => {
    const { db } = freshDb();
    const a = appendAudit(
      db,
      { actor: "owner", action: "x", target: "y", details: { b: 2, a: 1 } },
      clock,
    );
    expect(a.hash).toBe(
      computeAuditHash({
        seq: a.seq,
        ts: a.ts,
        actor: "owner",
        action: "x",
        target: "y",
        details: { a: 1, b: 2 },
        prev_hash: GENESIS_HASH,
      }),
    );
    expect(JSON.parse(a.details_json)).toEqual({ a: 1, b: 2 });
  });

  it("verifies an intact chain and reports the event count", () => {
    const { db } = freshDb();
    for (let i = 0; i < 25; i++)
      appendAudit(db, { actor: "o", action: `a${i}`, target: "t", details: { i } }, clock);
    expect(verifyAuditChain(db)).toEqual({ ok: true, count: 25 });
  });

  it("verifies an empty chain", () => {
    const { db } = freshDb();
    expect(verifyAuditChain(db)).toEqual({ ok: true, count: 0 });
  });

  it("refuses UPDATE and DELETE through the database triggers", () => {
    const { db } = freshDb();
    appendAudit(db, { actor: "o", action: "a", target: "t", details: {} }, clock);
    expect(() => db.prepare("UPDATE audit_events SET actor = 'evil'").run()).toThrow(
      /append-only|audit/i,
    );
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only|audit/i);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  describe("tamper detection (triggers removed by an attacker with file access)", () => {
    const tamper = (mutate: (db: ReturnType<typeof freshDb>["db"]) => void) => {
      const { db } = freshDb();
      for (let i = 1; i <= 5; i++)
        appendAudit(db, { actor: "o", action: `a${i}`, target: "t", details: { i } }, clock);
      db.exec(
        "DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;",
      );
      mutate(db);
      return verifyAuditChain(db);
    };

    it("detects an edited field", () => {
      const r = tamper((db) =>
        db.prepare("UPDATE audit_events SET actor = 'evil' WHERE seq = 3").run(),
      );
      expect(r).toMatchObject({ ok: false, brokenAt: 3 });
    });

    it("detects edited details", () => {
      const r = tamper((db) =>
        db.prepare(`UPDATE audit_events SET details_json = '{"i":99}' WHERE seq = 2`).run(),
      );
      expect(r).toMatchObject({ ok: false, brokenAt: 2 });
    });

    it("detects a deleted middle event (gap)", () => {
      const r = tamper((db) => db.prepare("DELETE FROM audit_events WHERE seq = 3").run());
      expect(r).toMatchObject({ ok: false, brokenAt: 3 });
      expect((r as { reason: string }).reason).toMatch(/gap|missing|seq/i);
    });

    it("detects a rewritten prev_hash even when the event hash is recomputed by the attacker", () => {
      const r = tamper((db) => {
        const row = db.prepare("SELECT * FROM audit_events WHERE seq = 4").get() as Record<
          string,
          string | number
        >;
        const forged = computeAuditHash({
          seq: 4,
          ts: row.ts as string,
          actor: "forged",
          action: row.action as string,
          target: row.target as string,
          details: JSON.parse(row.details_json as string),
          prev_hash: row.prev_hash as string,
        });
        db.prepare("UPDATE audit_events SET actor = 'forged', hash = ? WHERE seq = 4").run(forged);
      });
      // Event 4 now hashes correctly on its own, but event 5 still points at the old hash.
      expect(r).toMatchObject({ ok: false, brokenAt: 5 });
    });

    it("detects truncation only when a later checkpoint is supplied", () => {
      const { db } = freshDb();
      for (let i = 1; i <= 4; i++)
        appendAudit(db, { actor: "o", action: `a${i}`, target: "t", details: {} }, clock);
      const head = verifyAuditChain(db);
      expect(head).toMatchObject({ ok: true, count: 4 });
      db.exec("DROP TRIGGER IF EXISTS audit_events_no_delete;");
      db.prepare("DELETE FROM audit_events WHERE seq > 2").run();
      expect(verifyAuditChain(db)).toEqual({ ok: true, count: 2 });
      expect(verifyAuditChain(db, { expectedCount: 4 })).toMatchObject({ ok: false });
    });
  });

  it("keeps seq contiguous when two connections append in turn", () => {
    const { db, file } = freshDb();
    const other = openDatabase(file);
    migrate(other, defaultMigrationsDir());
    for (let i = 0; i < 10; i++) {
      appendAudit(
        i % 2 === 0 ? db : other,
        { actor: "o", action: `a${i}`, target: "t", details: { i } },
        clock,
      );
    }
    expect(verifyAuditChain(db)).toEqual({ ok: true, count: 10 });
    expect(
      (db.prepare("SELECT seq FROM audit_events ORDER BY seq").all() as { seq: number }[]).map(
        (r) => r.seq,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("rolls the event back if the surrounding transaction fails", () => {
    const { db } = freshDb();
    appendAudit(db, { actor: "o", action: "kept", target: "t", details: {} }, clock);
    expect(() =>
      db.transaction(() => {
        appendAudit(db, { actor: "o", action: "lost", target: "t", details: {} }, clock);
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(verifyAuditChain(db)).toEqual({ ok: true, count: 1 });
  });

  it("rejects details that cannot be serialised canonically", () => {
    const { db } = freshDb();
    expect(() =>
      appendAudit(db, { actor: "o", action: "a", target: "t", details: { n: Number.NaN } }, clock),
    ).toThrow(/finite/i);
    expect(verifyAuditChain(db).count).toBe(0);
  });

  it("opens a database in a nested, not-yet-existing directory", () => {
    const db = openDatabase(join(tempDir(), "a", "b", "stack.db"));
    migrate(db, defaultMigrationsDir());
    expect(verifyAuditChain(db)).toEqual({ ok: true, count: 0 });
  });
});
