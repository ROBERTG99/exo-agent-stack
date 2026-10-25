// D-01 to D-04 and D-19: Exo itself, and where the stack listens.
import { fail, hostOfAddress, isLoopbackHost, list, pass, skip, type Check } from "./types.ts";

export const exoChecks: Check[] = [
  {
    id: "D-01",
    title: "Exo commit equals the pin",
    run: ({ exo }) => {
      if (!exo.commit || !exo.pin)
        return skip("vendor/exo is not checked out, so there is no commit to compare");
      return exo.commit === exo.pin
        ? pass(`Exo is at the pinned commit ${exo.pin.slice(0, 12)}`)
        : fail(
            `Exo is at ${exo.commit.slice(0, 12)} but the pin is ${exo.pin.slice(0, 12)}`,
            "Check out the pinned commit (`git submodule update --init vendor/exo`), or move the pin deliberately with the upgrade-exo-pin skill.",
          );
    },
  },
  {
    id: "D-02",
    title: "Exo serve is bound to loopback, without --auth-file or --multiplayer",
    run: ({ exo }) => {
      const problems: string[] = [];
      const host = hostOfAddress(exo.bind);
      if (!isLoopbackHost(host)) problems.push(`bound to ${exo.bind}`);
      for (const flag of exo.serve_flags) {
        const name = flag.split("=")[0];
        if (name === "--auth-file" || name === "--multiplayer") problems.push(`runs with ${name}`);
      }
      return problems.length === 0
        ? pass(`Exo serves on ${exo.bind} with no auth file and no multiplayer`)
        : fail(
            `Exo ${problems.join("; ")}`,
            "Run `exo run --serve --bind 127.0.0.1:9810` without --auth-file and --multiplayer (BUILD.md §0.1, rail 3).",
          );
    },
  },
  {
    id: "D-03",
    title: "Compose ports are prefixed 127.0.0.1",
    run: ({ compose }) => {
      const open = compose.ports.filter(
        (p) => !p.startsWith("127.0.0.1:") && !p.startsWith("[::1]:"),
      );
      const host = compose.network_modes.filter((m) => m === "host");
      if (open.length === 0 && host.length === 0) {
        return pass(`${compose.ports.length} published ports, all on 127.0.0.1`);
      }
      return fail(
        [
          open.length ? `published without a loopback prefix: ${list(open)}` : "",
          host.length ? "a service uses host networking" : "",
        ]
          .filter(Boolean)
          .join("; "),
        'Write every port as "127.0.0.1:<host>:<container>" and do not use network_mode: host.',
      );
    },
  },
  {
    id: "D-04",
    title: "stackd, the bridge and the dashboard listen on loopback only",
    run: ({ listeners }) => {
      if (listeners.length === 0) return skip("no stack service is listening");
      const open = listeners.filter((l) => !isLoopbackHost(l.host));
      return open.length === 0
        ? pass(`${listeners.length} listeners, all on loopback`)
        : fail(
            `listening beyond loopback: ${list(open.map((l) => `${l.service} on ${l.host}:${l.port}`))}`,
            "Bind 127.0.0.1 (EXOS_LISTEN_HOST must stay 127.0.0.1 outside a container).",
          );
    },
  },
  {
    id: "D-19",
    title: "The Exo submodule is clean, apart from recorded patches",
    run: ({ submodule }) => {
      if (!submodule.dirty) return pass("vendor/exo has no local changes");
      return submodule.patches_recorded
        ? pass("vendor/exo is modified and every change is recorded in patches/")
        : fail(
            "vendor/exo has changes that are not recorded as patches",
            "Move the change into patches/ (and docs/upstream/), then restore the submodule: vendor/exo is read-only.",
          );
    },
  },
];
