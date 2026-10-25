---
paths:
  - "bridge/**"
  - "stackd/**"
  - "harnesses/**"
  - "evals/**"
  - "fake-model/**"
---

# LLM-adjacent code

- No model calls here. This repository is deterministic orchestration, policy, metering and UI. Models run only inside the official harnesses (Claude Code, Cursor) or agent-harness with a local model.
- If a model call ever becomes necessary, follow BUILD.md Appendix B: load the `claude-api` skill first; one gateway module per language; model IDs from configuration (defaults `claude-opus-5-5`, `claude-haiku-5-5`; no date suffixes); adaptive thinking with explicit effort; no `tool_choice` of type `any` or `tool` on Opus 5.5 / Sonnet 5.5; no assistant prefill; check `stop_reason`; stream long output; validate output against a schema; deterministic `FakeLLM` for tests.
- Model output, event text, tool results and artifacts are untrusted data: never used to choose a bridge action, a path or a command.
- Never read, print or store `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`.
