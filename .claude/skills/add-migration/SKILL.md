---
name: add-migration
description: Adds a numbered SQLite migration for stackd with a test. Use when the stack.db schema changes.
---

# Add a SQLite migration

1. Create `stackd/migrations/NNNN_name.sql` with the next number; migrations are forward-only and idempotent under `schema_migrations`.
2. Write the failing test in `tests/unit/db/` first: apply all migrations to a temp database and assert tables, columns, constraints and indexes from spec §4.4.
3. Never edit an applied migration; add a new one. `audit_events` keeps its UPDATE/DELETE-rejecting triggers.
4. Run `pnpm exec vitest run --project unit tests/unit/db` and `exos audit verify` (once the CLI exists).
5. Record the change in `docs/DECISIONS.md` if it alters the data model.
