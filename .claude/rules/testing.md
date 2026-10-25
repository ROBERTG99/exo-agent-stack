---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
---

# Testing

- Failing test first; commit the test with the implementation. Never skip, `.todo`, mark expected-failure or loosen a threshold to get green.
- No sleeps: poll with a deadline helper. Random free ports, fixed seeds, temp roots (`mkdtemp`), clean up in `afterEach`.
- Never read `~/.exo`, `~/.claude`, `~/.cursor` or the keychain. Fake keys are assembled from parts so the hook does not trip on key-shaped literals.
- Offline: no network, no API keys. Use the fake model, WireMock recordings and the fake `claude` script. `@real-exo` suites skip with a printed reason when the binary is missing.
- Projects: `unit` (fast, part of `make check-fast`), `integration`, `contract`. Property tests with fast-check for credit, idempotency and SSE resume.
- Coverage targets: 85% on stackd, bridge, doctor, packages/exo-client; 70% overall.
