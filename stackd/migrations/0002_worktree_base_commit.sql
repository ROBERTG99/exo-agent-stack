-- The commit a thread's worktree branch started from, so a repeated create can report it.
ALTER TABLE worktrees ADD COLUMN base_commit TEXT NOT NULL DEFAULT '';
