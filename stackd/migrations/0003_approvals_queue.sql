-- The approvals queue (BUILD.md §4.4, FR-11): enough about each request to list it, decide it and
-- show where it came from, plus a per-thread cursor so the queue reads each Exo event once.
ALTER TABLE approvals ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN thread_slug TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN call_id TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN requested_at TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN decided_at TEXT;
-- The question of an ask_user request: text an agent wrote, shown as untrusted.
ALTER TABLE approvals ADD COLUMN untrusted_text TEXT;

CREATE TABLE approval_cursors (
  thread_id     TEXT PRIMARY KEY,
  last_event_id TEXT NOT NULL
);
