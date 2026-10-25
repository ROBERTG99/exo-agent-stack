# ADR 0009: Container services listen on all interfaces inside the container

- **Status:** accepted
- **Date:** 2026-10-25
- **Deciders:** build agent, per BUILD.md §0.2 (recorded in `docs/DECISIONS.md`)

## Context

BUILD.md §0.1 rail 3 requires every listener to bind `127.0.0.1`, and compose ports to carry the
`127.0.0.1:` prefix. A process inside a container that binds only the container's own loopback is
unreachable through Docker's published ports, because the forwarded connection arrives on the
container's `eth0`. The default compose stack (stackd, fake model, later bridge and dashboard) must
be reachable from the host browser and from the other containers.

## Decision

- Host processes bind loopback only. `resolveListenHost` (`packages/common/src/listen-host.ts`)
  refuses everything except `127.0.0.1`, `localhost` and `::1`.
- A container image may listen on all interfaces of its own network namespace, through the value
  `EXOS_LISTEN_HOST=container`. The value is honoured only when `EXOS_IN_CONTAINER=1` **and** the
  process sees a container filesystem (`/.dockerenv` or `/run/.containerenv`). Setting the flag on
  the host does nothing.
- Compose publishes every port as `127.0.0.1:<host>:<container>`; `network_mode: host` is not used.
  The container ports are therefore reachable only from the machine itself.
- The guard hook blocks setting `EXOS_IN_CONTAINER`, a non-loopback `EXOS_LISTEN_HOST`, `0.0.0.0`
  binds, unprefixed publish flags and host networking from the agent's shell.

## Alternatives considered

- **Bind `127.0.0.1` inside the container and use host networking.** Satisfies the rail literally but
  host networking exposes every container port on the host and does not work on Docker Desktop for
  macOS.
- **A per-container reverse proxy bound to the container IP.** Adds a component to reach the same
  result; the listener would still not be loopback inside the namespace.
- **Resolve the container's own interface address.** Fragile (addresses change per network) and gives
  no stronger guarantee than the published-port prefix.

## Consequences

- The effective exposure boundary is the published port, so the compose checks are security
  controls: `tests/integration/skeleton.test.ts` (static), `tests/integration/loopback.test.ts`
  (running stack, T-47) and doctor checks `D-03`/`D-04`.
- `make security` must allow-list `packages/common/src/listen-host.ts` as the only source file
  containing the all-interfaces address.

## Evidence

`lsof -nP -iTCP -sTCP:LISTEN` while `make up` is running lists only `127.0.0.1:9812`, `:9840` and
`:9841` (recorded in `PROGRESS.md`, T-06).
