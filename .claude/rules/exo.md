---
paths:
  - "vendor/**"
  - "harnesses/**"
  - "packages/exo-client/**"
  - "agents/**"
  - "environments/**"
---

# Exo integration

- `vendor/exo` is read-only. Fixes go to `patches/` (only if needed) and proposals to `docs/upstream/`; nothing is sent upstream.
- Verify every Exo command, frontmatter field, HTTP endpoint and event type against the pinned source before use. Record item, `file:line`, result and consequence in `docs/exo-verification.md`; V-1 to V-11 are listed in BUILD.md §4.2.
- If an item cannot be verified, take the documented fallback and record it in `docs/KNOWN_LIMITATIONS.md`.
- stackd is the only Exo writer. Unknown event types render generically. Exo state is never copied into SQLite.
- Recordings in `fixtures/exo-recordings/` must keep shapes identical to a host re-recording.
