# Dual-review streams

`claude.review.md` and `cursor.review.md` are **hand-written** reviews of `fixtures/review-target`,
standing in for the `write_report` artifacts of a real `claude-host` thread and a real `cursor`
thread. They were not produced by a model run (the build never makes one), and their findings were
chosen to give the comparison an overlap, a near miss and one finding per side only.

A live run replaces them: `make live-cursor` / `make eval-live` (maintainer only) start the two
review threads on the maintainer's subscriptions and save the artifacts, which
`exos dual-review compare` reads in the same format.
