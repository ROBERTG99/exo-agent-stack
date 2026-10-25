# Review of fixtures/review-target (cursor)

Synthetic stream used by the offline dual-review comparison tests; see README.md in this folder.

## Findings

- [correctness] src/math.ts:3 off-by-one in the loop bound
- [security] src/db.ts:5 SQL injection through the `name` parameter
- [concurrency] src/queue.ts:6 module-level counter assigned after an await is racy
- [style] src/queue.ts:1 module state that could be a local
