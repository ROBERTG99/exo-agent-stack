---
paths:
  - "docker/**"
  - "compose*.yaml"
  - "**/Dockerfile*"
  - ".devcontainer/**"
---

# Docker

- Multi-stage, `node:22-slim` build, slim or distroless runtime, non-root user, `HEALTHCHECK`, `ARG HTTPS_PROXY` in every stage that downloads packages, no `apt-get`.
- Compose ports are always `127.0.0.1:<port>:<port>`; `depends_on` uses `condition: service_healthy`; profiles `observability`, `real-exo`, `local-model`.
- No secrets in images or compose files; containers need no outbound network at runtime.
- hadolint and trivy must be clean (or documented in `docs/security.md`).
