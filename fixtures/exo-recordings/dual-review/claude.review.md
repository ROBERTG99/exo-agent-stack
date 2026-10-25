# Review of fixtures/review-target (claude-host)

Synthetic stream used by the offline dual-review comparison tests; see README.md in this folder.

## Findings

- [correctness] src/math.ts:3 loop condition `i <= values.length` reads one element past the end
- [security] src/db.ts:6 SQL string built by concatenating the caller-supplied name
- [concurrency] src/queue.ts:4 read-modify-write of `pending` across an await
- [error-handling] src/math.ts:6 division by `values.length` when the array is empty
