-- stackd data model (BUILD.md §4.4). Exo state is never copied here.
-- Money is integer micro-dollars; the CHECKs make a float or a negative value impossible to store.

CREATE TABLE usage_events (
  event_id              TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL,
  thread_id             TEXT NOT NULL,
  turn_id               TEXT NOT NULL,
  pool                  TEXT NOT NULL,
  model                 TEXT NOT NULL,
  prompt_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cached_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cost_micros           INTEGER NOT NULL CHECK (typeof(cost_micros) = 'integer' AND cost_micros >= 0),
  cost_source           TEXT NOT NULL CHECK (cost_source IN ('exo', 'price_table', 'max_estimate')),
  cycle                 TEXT NOT NULL CHECK (cycle GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
);
CREATE INDEX usage_events_cycle_pool ON usage_events (cycle, pool);

CREATE TABLE credit_state (
  cycle         TEXT NOT NULL,
  pool          TEXT NOT NULL,
  budget_micros INTEGER NOT NULL CHECK (typeof(budget_micros) = 'integer' AND budget_micros >= 0),
  spent_micros  INTEGER NOT NULL CHECK (typeof(spent_micros) = 'integer' AND spent_micros >= 0),
  state         TEXT NOT NULL CHECK (state IN ('ok', 'warn', 'stop')),
  changed_at    TEXT NOT NULL,
  PRIMARY KEY (cycle, pool)
);

CREATE TABLE meter_cursors (
  thread_id     TEXT PRIMARY KEY,
  last_event_id TEXT NOT NULL
);

CREATE TABLE idempotency (
  key           TEXT PRIMARY KEY CHECK (length(key) BETWEEN 8 AND 128),
  args_sha256   TEXT NOT NULL,
  status        TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE approvals (
  approval_id   TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_redacted TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'denied', 'approved_for_session', 'dashboard_only')),
  decided_by    TEXT
);
CREATE INDEX approvals_decision ON approvals (decision);

CREATE TABLE worktrees (
  thread_slug   TEXT PRIMARY KEY,
  repo_path     TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  branch        TEXT NOT NULL
);

CREATE TABLE recoveries (
  turn_id  TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  outcome  TEXT
);

-- Hash-chained, append-only audit log. Tampering is also detected by `exos audit verify`.
CREATE TABLE audit_events (
  seq          INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  details_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash         TEXT NOT NULL CHECK (length(hash) = 64)
);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE rejected');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE rejected');
END;
