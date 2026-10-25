---
paths:
  - "dashboard/**"
---

# Dashboard (React, Vite, TanStack Query, Tailwind, Radix)

- Design tokens live in `dashboard/src/tokens.css` ("control deck"); never hard-code colours. Dark is the default, light tokens must also pass AA.
- Every screen implements loading, empty, error and success states. Keyboard-only usable, works at 375 px, WCAG 2.2 AA; axe runs in every Playwright spec.
- Data only through the typed OpenAPI client (`openapi-typescript` output); one SSE hook for live events.
- Agent output is always rendered as text inside a block labelled "agent output (untrusted)": never `dangerouslySetInnerHTML`, never Markdown links auto-opened, never used to build a request.
- Ledger values are labelled "API-rate equivalent".
