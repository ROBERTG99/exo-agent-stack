---
name: add-bridge-tool
description: Adds or changes an MCP tool in the bridge: zod schema, stackd route, plugin, Cursor rule, eval case. Use for any bridge tool change.
---

# Add a bridge tool

1. Failing contract test first (`tests/contract/bridge-tools.test.ts`): the `tools/list` snapshot in `bridge/schemas/tools.v1.json` and the error codes of spec §4.6.
2. Define the zod schema and handler in `bridge/src/tools/`; results carry `structuredContent` plus a one-line text; agent text is wrapped `{untrusted: true, text}` with the `<<untrusted agent output>>` prefix; set annotations (readOnly/write/destructive).
3. Add or reuse the stackd route (`add-endpoint` skill). Writes need `idempotency_key`.
4. Update the plugin (`plugin/`), the Cursor rule (`.cursor/rules/exo-delegation.mdc`) and add a delegation eval case (`add-eval-case`).
5. `exo_approve` stays human-initiated and is never granted an allow rule.
