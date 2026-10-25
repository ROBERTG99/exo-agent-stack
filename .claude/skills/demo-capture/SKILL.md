---
name: demo-capture
description: Runs the offline demo and captures screenshots and video into docs/images/. Use after UI or demo changes.
---

# Demo capture

1. `make up` then `make seed`, then `make demo` (delegates, approves, recovers, forks, all offline against the fake model).
2. Capture screenshots for every dashboard screen with the Playwright specs (`make e2e`), saved under `docs/images/`; record `docs/images/demo.webm` from the demo spec.
3. Only real captures go in the README; no mock-ups. Check axe output is clean before saving.
4. `make down` when done.
