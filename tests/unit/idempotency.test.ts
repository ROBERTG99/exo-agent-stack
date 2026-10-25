import { describe, expect, it } from "vitest";
import { ApiError } from "../../stackd/src/errors.ts";
import { Idempotency, RETENTION_DAYS } from "../../stackd/src/idempotency.ts";
import { freshDb } from "./db/helpers.ts";

const KEY = "key-0000-aaaa-0001";

function setup(now = new Date("2026-10-25T00:00:00Z")) {
  const { db } = freshDb();
  let clock = now;
  const idem = new Idempotency(db, () => clock);
  return {
    db,
    idem,
    advance: (days: number) => (clock = new Date(clock.getTime() + days * 86_400_000)),
  };
}

describe("Idempotency.run", () => {
  it("runs once and replays the stored response for the same body", async () => {
    const { idem } = setup();
    let runs = 0;
    const fn = async () => ({ id: ++runs });
    const first = await idem.run(KEY, "op", { a: 1 }, fn);
    const second = await idem.run(KEY, "op", { a: 1 }, fn);
    expect(first).toEqual({ value: { id: 1 }, replayed: false });
    expect(second).toEqual({ value: { id: 1 }, replayed: true });
    expect(runs).toBe(1);
  });

  it("treats key order in the body as the same request (canonical JSON)", async () => {
    const { idem } = setup();
    await idem.run(KEY, "op", { a: 1, b: 2 }, async () => ({ ok: true }));
    const again = await idem.run(KEY, "op", { b: 2, a: 1 }, async () => ({ ok: false }));
    expect(again.replayed).toBe(true);
  });

  it("refuses a different body, or the same body for another operation, with 409", async () => {
    const { idem } = setup();
    await idem.run(KEY, "op", { a: 1 }, async () => ({ ok: true }));
    for (const [op, body] of [
      ["op", { a: 2 }],
      ["other-op", { a: 1 }],
    ] as const) {
      await expect(idem.run(KEY, op, body, async () => ({}))).rejects.toMatchObject({
        status: 409,
        code: "idempotency_conflict",
      });
    }
  });

  it("never runs two calls with one key at the same time", async () => {
    const { idem } = setup();
    let running = 0;
    let peak = 0;
    let runs = 0;
    const fn = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return { n: ++runs };
    };
    const results = await Promise.all([1, 2, 3].map(() => idem.run(KEY, "op", {}, fn)));
    expect(peak).toBe(1);
    expect(runs).toBe(1);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true, true]);
  });

  it("lets different keys run in parallel", async () => {
    const { idem } = setup();
    let running = 0;
    let peak = 0;
    const fn = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return {};
    };
    await Promise.all(
      ["key-0000-aaaa-0001", "key-0000-aaaa-0002"].map((k) => idem.run(k, "op", {}, fn)),
    );
    expect(peak).toBe(2);
  });

  it("resumes from the saved progress after a failure that came after a step", async () => {
    const { idem } = setup();
    const seen: unknown[] = [];
    const attempt = async (fail: boolean) =>
      idem.run(KEY, "op", {}, async (progress, save) => {
        seen.push({ ...progress });
        if (!progress.thread) save({ thread: "t1" });
        if (fail) throw new Error("exo went away");
        return { thread: progress.thread ?? "t1" };
      });
    await expect(attempt(true)).rejects.toThrow("exo went away");
    const second = await attempt(false);
    expect(seen).toEqual([{}, { thread: "t1" }]);
    expect(second).toEqual({ value: { thread: "t1" }, replayed: false });
    expect((await attempt(false)).replayed).toBe(true);
  });

  it("frees the key when the run failed before it saved anything", async () => {
    const { idem, db } = setup();
    await expect(
      idem.run(KEY, "op", { v: 1 }, async () => {
        throw new ApiError(404, "not_found", "Not found");
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency").get()).toEqual({ n: 0 });
    const corrected = await idem.run(KEY, "op", { v: 2 }, async () => ({ ok: true }));
    expect(corrected.replayed).toBe(false);
  });

  it("stores a canonical response and rejects a key outside 8 to 128 characters at the database", async () => {
    const { idem, db } = setup();
    await idem.run(KEY, "op", {}, async () => ({ b: 1, a: 2 }));
    expect(db.prepare("SELECT response_json FROM idempotency").get()).toEqual({
      response_json: '{"a":2,"b":1}',
    });
    expect(() =>
      db
        .prepare(
          "INSERT INTO idempotency (key, args_sha256, status, response_json, created_at) VALUES ('short', 'x', 'done', '{}', 'now')",
        )
        .run(),
    ).toThrow();
  });
});

describe("Idempotency.purge", () => {
  it("deletes keys older than the retention window and keeps newer ones", async () => {
    const { idem, advance, db } = setup();
    await idem.run("key-0000-old-0001", "op", {}, async () => ({}));
    advance(RETENTION_DAYS - 1);
    await idem.run("key-0000-new-0001", "op", {}, async () => ({}));
    advance(2);
    expect(idem.purge()).toBe(1);
    expect(db.prepare("SELECT key FROM idempotency").all()).toEqual([{ key: "key-0000-new-0001" }]);
  });
});
