import { canonicalJson, sha256Hex } from "@exos/common";
import type { Db } from "./connection.ts";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditInput {
  actor: string;
  action: string;
  target: string;
  details?: unknown;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details_json: string;
  prev_hash: string;
  hash: string;
}

export interface HashInput {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details: unknown;
  prev_hash: string;
}

export function computeAuditHash(input: HashInput): string {
  return sha256Hex(
    canonicalJson({
      seq: input.seq,
      ts: input.ts,
      actor: input.actor,
      action: input.action,
      target: input.target,
      details: input.details,
      prev_hash: input.prev_hash,
    }),
  );
}

/**
 * Appends one event to the hash chain. The read of the previous hash and the insert happen in one
 * immediate transaction, so concurrent writers cannot fork the chain; inside an outer transaction
 * the event is part of it and rolls back with it.
 */
export function appendAudit(
  db: Db,
  input: AuditInput,
  clock: () => Date = () => new Date(),
): AuditEvent {
  const details = input.details ?? {};
  const details_json = canonicalJson(details); // throws before touching the database
  return db
    .transaction((): AuditEvent => {
      const last = db
        .prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; hash: string } | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const prev_hash = last?.hash ?? GENESIS_HASH;
      const ts = clock().toISOString();
      const hash = computeAuditHash({
        seq,
        ts,
        actor: input.actor,
        action: input.action,
        target: input.target,
        details,
        prev_hash,
      });
      const event: AuditEvent = {
        seq,
        ts,
        actor: input.actor,
        action: input.action,
        target: input.target,
        details_json,
        prev_hash,
        hash,
      };
      db.prepare(
        `INSERT INTO audit_events (seq, ts, actor, action, target, details_json, prev_hash, hash)
         VALUES (@seq, @ts, @actor, @action, @target, @details_json, @prev_hash, @hash)`,
      ).run(event);
      return event;
    })
    .immediate();
}

export interface AuditVerification {
  ok: boolean;
  /** Events verified (all of them when ok). */
  count: number;
  brokenAt?: number;
  reason?: string;
}

/**
 * Recomputes the whole chain. Detects edited fields, a rewritten link, a deleted or inserted event.
 * Truncating the tail is invisible to the chain itself, so callers that keep a checkpoint pass
 * `expectedCount`.
 */
export function verifyAuditChain(db: Db, opts: { expectedCount?: number } = {}): AuditVerification {
  let expectedSeq = 1;
  let prev = GENESIS_HASH;
  let count = 0;
  const fail = (brokenAt: number, reason: string): AuditVerification => ({
    ok: false,
    count,
    brokenAt,
    reason,
  });
  for (const row of db
    .prepare("SELECT * FROM audit_events ORDER BY seq")
    .iterate() as Iterable<AuditEvent>) {
    if (row.seq !== expectedSeq) {
      return fail(expectedSeq, `gap in sequence: expected seq ${expectedSeq}, found ${row.seq}`);
    }
    if (row.prev_hash !== prev)
      return fail(row.seq, "prev_hash does not match the previous event's hash");
    let details: unknown;
    try {
      details = JSON.parse(row.details_json);
    } catch {
      return fail(row.seq, "details_json is not valid JSON");
    }
    const expected = computeAuditHash({ ...row, details });
    if (row.hash !== expected) return fail(row.seq, "hash does not match the event content");
    prev = row.hash;
    expectedSeq++;
    count++;
  }
  if (opts.expectedCount !== undefined && count < opts.expectedCount) {
    return fail(count + 1, `truncated: expected ${opts.expectedCount} events, found ${count}`);
  }
  return { ok: true, count };
}
