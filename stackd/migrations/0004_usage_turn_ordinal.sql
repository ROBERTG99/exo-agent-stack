-- A fork copies the events of its parent, usage included, under new event ids and the same turn id.
-- A turn runs once, so its n-th usage event is counted once: (turn_id, turn_ordinal) is unique, and
-- meter_turn_counts remembers how many usage events of each turn a thread has shown so far.
ALTER TABLE usage_events ADD COLUMN turn_ordinal INTEGER;
CREATE UNIQUE INDEX usage_events_turn_ordinal ON usage_events (turn_id, turn_ordinal)
  WHERE turn_id <> '' AND turn_ordinal IS NOT NULL;

CREATE TABLE meter_turn_counts (
  thread_id TEXT NOT NULL,
  turn_id   TEXT NOT NULL,
  n         INTEGER NOT NULL CHECK (n >= 0),
  PRIMARY KEY (thread_id, turn_id)
);
