---
name: new-adr
description: Creates an Architecture Decision Record in docs/adr/ and logs it in docs/DECISIONS.md. Use for any architectural choice.
---

# New ADR

1. Pick the next number in `docs/adr/` (planned: 0001 Exo as runtime, 0002 subscription-only with Mode A default, 0003 Mode B wrapper vs Rust patch, 0004 bridge as MCP server, 0005 pinned submodule, 0006 single-owner scope, 0007 fake model server, 0008 credit guard thresholds and integer math).
2. File `docs/adr/NNNN-kebab-title.md` with: Status, Date, Context, Decision, Alternatives considered, Consequences, Evidence (file:line, commands).
3. Add a dated entry to `docs/DECISIONS.md` linking the ADR.
4. Keep it under one page; link to code and tests rather than copying them.
