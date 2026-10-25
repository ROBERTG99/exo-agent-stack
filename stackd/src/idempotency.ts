// Idempotency keys (BUILD.md §4.9). A key is stored with sha256(canonical_json({op, body})): the
// same body replays the stored response, a different body is a 409. While an operation runs its
// progress is saved after each Exo step, so a retry after a crash or a 503 resumes instead of
// repeating a step that already happened. Calls with the same key never run concurrently.
import { canonicalJson, sha256Hex } from "@exos/common";
import type { Db } from "./db/index.ts";
import { ApiError } from "./errors.ts";

export type Json = Record<string, unknown>;

export interface IdempotentRun<T> {
  value: T;
  replayed: boolean;
}

interface Row {
  args_sha256: string;
  status: "in_progress" | "done";
  response_json: string;
}

export const RETENTION_DAYS = 30;

export class Idempotency {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Runs `fn` once per key. `progress` holds what earlier attempts saved; `save` adds to it.
   * A failed run keeps what it saved and leaves the key open for a retry; a run that failed before
   * saving anything releases the key.
   */
  async run<T extends Json>(
    key: string,
    op: string,
    body: unknown,
    fn: (progress: Json, save: (more: Json) => void) => Promise<T>,
  ): Promise<IdempotentRun<T>> {
    return this.exclusive(key, async () => {
      const sha = sha256Hex(canonicalJson({ op, body }));
      const row = this.db
        .prepare("SELECT args_sha256, status, response_json FROM idempotency WHERE key = ?")
        .get(key) as Row | undefined;
      let progress: Json = {};
      if (row) {
        if (row.args_sha256 !== sha) {
          throw new ApiError(
            409,
            "idempotency_conflict",
            "Idempotency conflict",
            "this idempotency key was used with a different request",
          );
        }
        if (row.status === "done")
          return { value: JSON.parse(row.response_json) as T, replayed: true };
        progress = JSON.parse(row.response_json) as Json;
      } else {
        this.db
          .prepare(
            "INSERT INTO idempotency (key, args_sha256, status, response_json, created_at) VALUES (?, ?, 'in_progress', '{}', ?)",
          )
          .run(key, sha, this.clock().toISOString());
      }
      const save = (more: Json) => {
        progress = { ...progress, ...more };
        this.db
          .prepare(
            "UPDATE idempotency SET response_json = ? WHERE key = ? AND status = 'in_progress'",
          )
          .run(canonicalJson(progress), key);
      };
      let value: T;
      try {
        value = await fn(progress, save);
      } catch (err) {
        // Nothing happened yet (a validation or lookup error, Exo down before the first step):
        // free the key, so a corrected retry with a different body is not a conflict.
        if (Object.keys(progress).length === 0) {
          this.db
            .prepare("DELETE FROM idempotency WHERE key = ? AND status = 'in_progress'")
            .run(key);
        }
        throw err;
      }
      this.db
        .prepare("UPDATE idempotency SET status = 'done', response_json = ? WHERE key = ?")
        .run(canonicalJson(value), key);
      return { value, replayed: false };
    });
  }

  /** Deletes keys older than the retention window; returns how many. */
  purge(now: Date = this.clock()): number {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    return this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff).changes;
  }

  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
