# claude stream-json sample

`sample.ndjson` is **hand-written** from the public description of `claude -p --output-format
stream-json --verbose`; it is not a recording. No model call was made to produce it (the agent never
runs `claude` beyond `--version` and `--help`). The maintainer can replace it with a real capture
by running `make live-claude` (maintainer only); the stream parser is written to ignore unknown
fields and unknown message types.
