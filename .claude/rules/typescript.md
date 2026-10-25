---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript

- `strict` is on (`tsconfig.json`, TypeScript 6.0.x); no `any` without a comment explaining why, no `// @ts-ignore` (use `@ts-expect-error` with a reason).
- ESM only. `import type` for type-only imports (lint enforces it). Relative imports include the `.ts` extension.
- Validate every external input (HTTP body, MCP argument, event payload, env) with zod at the boundary; trust inferred types inside.
- No `console.log` in library code: use the shared logger (JSON, `correlation_id`).
- Money is integer micro-dollars (`bigint`-safe `number` below 2^53); never floats. Time comes from an injected clock so tests do not sleep.
- Errors: typed error classes with a stable `code`; never swallow; map to RFC 9457 `application/problem+json` at the HTTP edge and to `{code, message, details}` at the MCP edge.
- Every listener binds `127.0.0.1`.
