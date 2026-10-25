---
name: add-endpoint
description: Adds a stackd REST endpoint end to end: route, zod schema, tests, OpenAPI, dashboard types. Use for any new /api/v1 route.
---

# Add a stackd endpoint

1. Write the failing integration test (`tests/integration/`) including error cases: 401/403 (token, Host, Origin), 4xx validation as `application/problem+json`, and the credit/idempotency behaviour the spec requires.
2. Add the route in `stackd/src/routes/` with a zod request/response schema; writes require an `Idempotency-Key` when the spec says so and append an audit event.
3. Regenerate `stackd/openapi.yaml` and the dashboard types (`make docs`, or `mechanic` with the generate command).
4. Add or update the typed client call in `dashboard/src/api/` and `packages/exo-client` if Exo is involved.
5. Run `make check-fast` and the new integration test; update `PROGRESS.md`.
