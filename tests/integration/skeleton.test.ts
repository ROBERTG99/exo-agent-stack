import { connect, createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFakeModel, main as mainFakeModel } from "@exos/fake-model/server";
import { buildStackd, main as mainStackd } from "@exos/stackd/server";

const root = join(import.meta.dirname, "..", "..");

// A stand-in for Exo's HTTP API. The shape is a hand-written placeholder (see
// docs/KNOWN_LIMITATIONS.md) until T-08 records it from a real Exo.
async function startExoStub(agents: unknown[]) {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url?.startsWith("/exo/agent")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/exo`, seen, close: () => server.close() };
}

describe("fake-model skeleton", () => {
  const apps: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it("serves /healthz and /v1/models on loopback", async () => {
    const app = await buildFakeModel();
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    expect((app.server.address() as AddressInfo).address).toBe("127.0.0.1");

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "fake-model" });

    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    expect(models.object).toBe("list");
    expect(models.data.map((m: { id: string }) => m.id)).toContain("fake-model");
  });
});

describe("stackd skeleton", () => {
  let stateDir: string;
  let exo: Awaited<ReturnType<typeof startExoStub>>;
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "stackd-"));
    exo = await startExoStub([
      { id: "agent-1", slug: "repo-builder", name: "repo-builder" },
      { id: "agent-2", slug: "reviewer-cursor", name: "reviewer-cursor" },
    ]);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    exo.close();
  });

  async function start() {
    const stackd = await buildStackd({ stateDir, exoUrl: exo.url });
    apps.push(stackd.app);
    await stackd.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (stackd.app.server.address() as AddressInfo).port;
    return { ...stackd, base: `http://127.0.0.1:${port}`, port };
  }

  it("creates the local token with mode 0600 and reuses it", async () => {
    const a = await start();
    const file = join(stateDir, "local-token");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).toBe(token);

    const b = await buildStackd({ stateDir, exoUrl: exo.url });
    expect(b.token).toBe(token);
    await b.app.close();
  });

  it("listens on 127.0.0.1 only", async () => {
    const { app } = await start();
    expect((app.server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("GET /api/v1/health is open and reports Exo reachability", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      service: "stackd",
      exo: { reachable: true },
    });
  });

  it("reports exo unreachable without failing the health probe", async () => {
    exo.close();
    const { base } = await start();
    const body = await (await fetch(`${base}/api/v1/health`)).json();
    expect(body.status).toBe("degraded");
    expect(body.exo.reachable).toBe(false);
  });

  it("GET /api/v1/agents requires the bearer token (problem+json 401)", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/v1/agents`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
    expect(await res.json()).toMatchObject({ status: 401, code: "unauthorized" });

    const wrong = await fetch(`${base}/api/v1/agents`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("lists agents from Exo with a valid token", async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents.map((a: { slug: string }) => a.slug)).toEqual([
      "repo-builder",
      "reviewer-cursor",
    ]);
    expect(exo.seen).toContain("GET /exo/agent");
  });

  it("returns 503 problem+json when Exo is down", async () => {
    const { base, token } = await start();
    exo.close();
    const res = await fetch(`${base}/api/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "exo_unavailable" });
  });

  it("rejects a wrong Host header (DNS rebinding) with 403", async () => {
    const { port, token } = await start();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/v1/health",
          headers: { host: "evil.example:" + port, authorization: `Bearer ${token}` },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects a Host header without a port and a Host with the wrong port", async () => {
    const { port } = await start();
    const { request } = await import("node:http");
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/api/v1/health", headers: { host } },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.on("error", reject);
        req.end();
      });
    expect(await status("127.0.0.1")).toBe(403);
    expect(await status("127.0.0.1:1")).toBe(403);
    expect(await status(`localhost:${port}`)).toBe(200);
  });

  it("uses publicPort when it differs from the socket port, and rejects Origin: null", async () => {
    const stackd = await buildStackd({ stateDir, exoUrl: exo.url, publicPort: 9812 });
    apps.push(stackd.app);
    await stackd.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (stackd.app.server.address() as AddressInfo).port;
    // The browser-visible port is 9812, so a Host naming the real socket port is refused.
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(403);

    const other = await start();
    const nullOrigin = await fetch(`${other.base}/api/v1/health`, { headers: { origin: "null" } });
    expect(nullOrigin.status).toBe(403);
  });

  it("accepts localhost:<port> as Host", async () => {
    const { port } = await start();
    const res = await fetch(`http://localhost:${port}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it("rejects a cross-site Origin with 403 but allows the dashboard origin", async () => {
    const { base } = await start();
    const bad = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "https://evil.example" },
    });
    expect(bad.status).toBe(403);
    const dash = await fetch(`${base}/api/v1/health`, {
      headers: { origin: "http://127.0.0.1:9800" },
    });
    expect(dash.status).toBe(200);
  });
});

async function freePort(): Promise<number> {
  const s = createTcpServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 1500 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe("service entrypoints honour the loopback-only rail", () => {
  const apps: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  const stateDirEnv = () => mkdtempSync(join(tmpdir(), "ep-"));
  const cases = [
    {
      name: "stackd",
      start: (port: number) =>
        mainStackd({
          EXOS_STACKD_PORT: String(port),
          EXOS_STATE_DIR: stateDirEnv(),
          EXOS_EXO_URL: "http://127.0.0.1:1/exo",
        }),
      withHost: (host: string, port: number) =>
        mainStackd({
          EXOS_LISTEN_HOST: host,
          EXOS_STACKD_PORT: String(port),
          EXOS_STATE_DIR: stateDirEnv(),
        }),
    },
    {
      name: "fake-model",
      start: (port: number) => mainFakeModel({ EXOS_FAKE_MODEL_PORT: String(port) }),
      withHost: (host: string, port: number) =>
        mainFakeModel({ EXOS_LISTEN_HOST: host, EXOS_FAKE_MODEL_PORT: String(port) }),
    },
  ];

  it.each(cases)(
    "$name main() listens on 127.0.0.1 and is unreachable on the LAN address",
    async (c) => {
      const port = await freePort();
      const app = await c.start(port);
      apps.push(app);
      expect((app.server.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(await canConnect("127.0.0.1", port)).toBe(true);
      if (lanAddress) expect(await canConnect(lanAddress, port)).toBe(false);
    },
  );

  it.each(cases)(
    "$name main() refuses a non-loopback EXOS_LISTEN_HOST before listening",
    async (c) => {
      const port = await freePort();
      await expect(c.withHost("0.0.0.0", port)).rejects.toThrow(/loopback/i);
      await expect(c.withHost("container", port)).rejects.toThrow(/container/i);
      expect(await canConnect("127.0.0.1", port)).toBe(false);
    },
  );
});

describe("skeleton deployment files", () => {
  it("WireMock mapping serves GET /exo/agent and is marked as a placeholder", () => {
    const file = join(root, "deploy/wiremock/mappings/exo-agent-list.json");
    const mapping = JSON.parse(readFileSync(file, "utf8"));
    expect(mapping.request).toMatchObject({ method: "GET", urlPath: "/exo/agent" });
    expect(mapping.response.status).toBe(200);
    expect(mapping.name).toMatch(/placeholder/i);
    const body = JSON.parse(mapping.response.body);
    expect(body.agents.length).toBeGreaterThanOrEqual(2);
  });

  const compose = parseYaml(readFileSync(join(root, "compose.yaml"), "utf8")) as {
    services: Record<string, Record<string, unknown>>;
  };

  it("keeps host-network builds out of the base file and in the cloud override", () => {
    expect(readFileSync(join(root, "compose.yaml"), "utf8")).not.toMatch(/network:\s*host/);
    const cloud = parseYaml(readFileSync(join(root, "compose.cloud.yaml"), "utf8")) as {
      services: Record<string, { build: { network: string } }>;
    };
    for (const svc of ["fake-model", "stackd"])
      expect(cloud.services[svc]!.build.network).toBe("host");
  });

  it("defines fake-model, wiremock and stackd", () => {
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining(["fake-model", "wiremock", "stackd"]),
    );
  });

  it("publishes every port on 127.0.0.1 only", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const p of (svc.ports as string[] | undefined) ?? []) {
        expect(p, `${name}: ${p}`).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
      }
    }
  });

  it("every service has a healthcheck and stackd waits for healthy dependencies", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      expect(svc.healthcheck, name).toBeDefined();
    }
    const deps = compose.services.stackd!.depends_on as Record<string, { condition: string }>;
    for (const d of ["wiremock", "fake-model"]) expect(deps[d]!.condition).toBe("service_healthy");
  });

  it("stackd points at WireMock as Exo and binds container-wide only through the guarded value", () => {
    const env = compose.services.stackd!.environment as Record<string, string>;
    expect(env.EXOS_EXO_URL).toBe("http://wiremock:8080/exo");
    expect(env.EXOS_LISTEN_HOST).toBe("container");
    expect(env.EXOS_IN_CONTAINER).toBe("1");
  });

  it("the fake-model image ships its scenario files", () => {
    const text = readFileSync(join(root, "docker/fake-model.Dockerfile"), "utf8");
    expect(text).toContain("COPY --from=build /repo/fake-model/scenarios ./scenarios");
    expect(text).toContain("FAKE_MODEL_SCENARIOS_DIR=/app/scenarios");
  });

  it("Dockerfiles are non-root-friendly, have HEALTHCHECK and ARG HTTPS_PROXY, and no apt-get", () => {
    for (const f of ["stackd", "fake-model"]) {
      const text = readFileSync(join(root, `docker/${f}.Dockerfile`), "utf8");
      expect(text).toContain("HEALTHCHECK");
      expect(text).toContain("ARG HTTPS_PROXY");
      expect(text).not.toMatch(/apt-get/);
      expect(text).toMatch(/^USER /m);
    }
  });
});
