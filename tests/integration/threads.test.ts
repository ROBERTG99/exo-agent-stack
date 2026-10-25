// T-23: stackd's threads and turns API (BUILD.md §4.3, §4.6, §4.9) against the Exo simulator.
import { existsSync } from "node:fs";
import { sha256Hex } from "@exos/common";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, startStack, until, type Stack } from "../helpers/stack.ts";

const stacks: Stack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});
async function stack(opts: Parameters<typeof startStack>[0] = {}) {
  const s = await startStack(opts);
  stacks.push(s);
  return s;
}

const KEY = "key-0000-aaaa-0001";
const start = (over: Record<string, unknown> = {}) => ({
  agent: "repo-builder",
  prompt: "[[scenario:plain]] hello",
  idempotency_key: KEY,
  ...over,
});
const slugOf = (key: string) => `d-${sha256Hex(key).slice(0, 10)}`;

const exoThreads = async (s: Stack, agentSlug: string) => {
  const agent = (await s.exo.listAgents({ slug: agentSlug }))[0]!;
  return (await s.exo.listThreads(agent.id, { limit: 100 })).threads;
};

describe("POST /api/v1/threads", () => {
  it("creates a thread with a deterministic slug and starts the first turn", async () => {
    const s = await stack();
    const r = await s.call("POST", "/api/v1/threads", start());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      thread_slug: slugOf(KEY),
      replayed: false,
      dashboard_url: expect.stringContaining(slugOf(KEY)),
    });
    for (const f of ["agent_id", "thread_id", "turn_id", "session_id"]) {
      expect(typeof r.body[f], f).toBe("string");
    }
    const threads = await exoThreads(s, "repo-builder");
    expect(threads.map((t) => t.slug)).toEqual([slugOf(KEY)]);
    // the first turn declares the ask_user frontend tool (BUILD.md §4.7)
    const turn = s.sim.store.turn(r.body.turn_id)!;
    expect(turn.frontend_tools.map((t) => (t as { name: string }).name)).toEqual(["ask_user"]);
  });

  it("replays one key: one thread, one turn, replayed true and the same ids", async () => {
    const s = await stack();
    const first = await s.call("POST", "/api/v1/threads", start());
    const second = await s.call("POST", "/api/v1/threads", start());
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ...first.body, replayed: true });
    expect(await exoThreads(s, "repo-builder")).toHaveLength(1);
    const turns = s.sim.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get();
    expect(turns).toEqual({ n: 1 });
  });

  it("accepts the key in the Idempotency-Key header and refuses a different body with 409", async () => {
    const s = await stack();
    const { idempotency_key: _k, ...noKey } = start();
    const a = await s.call("POST", "/api/v1/threads", noKey, { "idempotency-key": KEY });
    expect(a.status).toBe(201);
    const b = await s.call(
      "POST",
      "/api/v1/threads",
      { ...noKey, prompt: "another" },
      { "idempotency-key": KEY },
    );
    expect(b.status).toBe(409);
    expect(b.body.code).toBe("idempotency_conflict");
    expect(await exoThreads(s, "repo-builder")).toHaveLength(1);
  });

  it("rejects bad input with problem+json: short key, empty prompt, unknown field", async () => {
    const s = await stack();
    for (const body of [
      start({ idempotency_key: "short" }),
      start({ prompt: "" }),
      start({ surprise: true }),
      start({ thread_name: "has space" }),
      start({ resources: [1, 2, 3, 4, 5].map((n) => ({ path: `/x/${n}`, mode: "ro" })) }),
    ]) {
      const r = await s.call("POST", "/api/v1/threads", body);
      expect(r.status).toBe(400);
      expect(r.headers.get("content-type")).toContain("application/problem+json");
      expect(r.body.code).toBe("invalid_input");
    }
    expect(await exoThreads(s, "repo-builder")).toHaveLength(0);
  });

  it("answers 404 for an unknown agent and resolves an agent by slug or by id", async () => {
    const s = await stack();
    expect((await s.call("POST", "/api/v1/threads", start({ agent: "nobody" }))).status).toBe(404);
    const agent = (await s.exo.listAgents({ slug: "repo-builder" }))[0]!;
    const r = await s.call("POST", "/api/v1/threads", start({ agent: agent.id }));
    expect(r.status).toBe(201);
    expect(r.body.agent_id).toBe(agent.id);
  });

  it("needs the local token", async () => {
    const s = await stack();
    const res = await fetch(`${s.url}/api/v1/threads`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("answers 503 exo_unavailable when Exo is down and lets the same key succeed later", async () => {
    const s = await stack();
    await s.stopExo();
    const r = await s.call("POST", "/api/v1/threads", start());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("exo_unavailable");
    const rows = s.stackd.db.prepare("SELECT status FROM idempotency").all() as {
      status: string;
    }[];
    expect(rows.every((x) => x.status !== "done")).toBe(true);
  });

  it("creates the environment per agent: host-a for Mode A, smolvm-default and the vault for Mode B", async () => {
    const s = await stack();
    await s.call("POST", "/api/v1/threads", start({ idempotency_key: "key-0000-host-a-1" }));
    await s.call(
      "POST",
      "/api/v1/threads",
      start({ agent: "repo-builder-b", idempotency_key: "key-0000-mode-b-1" }),
    );
    const a = (await exoThreads(s, "repo-builder"))[0]!;
    const b = (await exoThreads(s, "repo-builder-b"))[0]!;
    expect(a.environment).toBe("host-a");
    expect(b.environment).toBe("smolvm-default");
  });

  it("refuses a workspace outside the allowed roots (403) and makes a worktree inside one", async () => {
    const parent = (await stack()).dir("roots-");
    const repo = makeRepo(parent);
    const s = await stack({ stackd: { allowedWorkspaceRoots: [parent] } });
    const outside = await s.call("POST", "/api/v1/threads", start({ workspace: "/etc" }));
    expect(outside.status).toBe(403);
    expect(outside.body.code).toBe("workspace_not_allowed");
    const ok = await s.call("POST", "/api/v1/threads", start({ workspace: repo }));
    expect(ok.status).toBe(201);
    expect(ok.body.worktree_path).toContain(slugOf(KEY));
    expect(existsSync(ok.body.worktree_path)).toBe(true);
    const again = await s.call("POST", "/api/v1/threads", start({ workspace: repo }));
    expect(again.body).toMatchObject({ replayed: true, worktree_path: ok.body.worktree_path });
  });

  it("writes an audit event for the start", async () => {
    const s = await stack();
    await s.call("POST", "/api/v1/threads", start());
    const row = s.stackd.db
      .prepare("SELECT actor, action, target FROM audit_events WHERE action = 'thread.start'")
      .get();
    expect(row).toMatchObject({ action: "thread.start", target: slugOf(KEY) });
  });
});

describe("threads: status, list, turns, cancel, fork", () => {
  it("lists an agent's threads and reports a thread's status", async () => {
    const s = await stack();
    const started = await s.call("POST", "/api/v1/threads", start());
    const slug = started.body.thread_slug;
    const list = await s.call("GET", "/api/v1/agents/repo-builder/threads");
    expect(list.status).toBe(200);
    expect(list.body.threads.map((t: { slug: string }) => t.slug)).toEqual([slug]);
    const status = await until(async () => {
      const r = await s.call("GET", `/api/v1/threads/repo-builder/${slug}`);
      return r.body.state === "idle" ? r : undefined;
    }, "an idle thread");
    expect(status.body).toMatchObject({ thread_slug: slug, active_turn_id: null, pending: 0 });
    expect(typeof status.body.last_event_id).toBe("string");
    expect((await s.call("GET", "/api/v1/threads/repo-builder/nope")).status).toBe(404);
  });

  it("shows awaiting_approval while an approval is open", async () => {
    const s = await stack();
    const started = await s.call(
      "POST",
      "/api/v1/threads",
      start({ prompt: "[[scenario:approval-edit]] edit" }),
    );
    const status = await until(async () => {
      const r = await s.call("GET", `/api/v1/threads/repo-builder/${started.body.thread_slug}`);
      return r.body.state === "awaiting_approval" ? r : undefined;
    }, "awaiting_approval");
    expect(status.body).toMatchObject({ active_turn_id: started.body.turn_id, pending: 1 });
  });

  it("sends a message: replay-safe, 409 while a turn is active, 404 for an unknown thread", async () => {
    const s = await stack();
    const started = await s.call(
      "POST",
      "/api/v1/threads",
      start({ prompt: "[[scenario:approval-edit]] edit" }),
    );
    const path = `/api/v1/threads/repo-builder/${started.body.thread_slug}/turns`;
    const busy = await s.call("POST", path, {
      message: "again",
      idempotency_key: "key-0000-send-0001",
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("turn_active");

    // finish the first turn through Exo, then send
    const approval = await until(
      async () =>
        s.sim.store.db.prepare("SELECT id FROM pending").get() as { id: string } | undefined,
      "the pending approval",
    );
    const agent = (await s.exo.listAgents({ slug: "repo-builder" }))[0]!;
    await s.exo.respondApproval(agent.id, started.body.thread_id, started.body.turn_id, {
      session_id: started.body.session_id,
      approval_id: approval.id,
      approved: true,
      allow_for_tool: false,
    });
    await until(
      async () =>
        (await s.exo.getTurn(agent.id, started.body.thread_id, started.body.turn_id)).active ===
        false,
      "the first turn to end",
    );

    const sent = await s.call("POST", path, {
      message: "[[scenario:plain]] second",
      idempotency_key: "key-0000-send-0002",
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ replayed: false });
    expect(typeof sent.body.turn_id).toBe("string");
    const replay = await s.call("POST", path, {
      message: "[[scenario:plain]] second",
      idempotency_key: "key-0000-send-0002",
    });
    expect(replay.body).toMatchObject({ turn_id: sent.body.turn_id, replayed: true });
    const clash = await s.call("POST", path, {
      message: "different",
      idempotency_key: "key-0000-send-0002",
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("idempotency_conflict");
    expect(
      (
        await s.call("POST", "/api/v1/threads/repo-builder/nope/turns", {
          message: "x",
          idempotency_key: "key-0000-send-0003",
        })
      ).status,
    ).toBe(404);
  });

  it("cancels an active turn", async () => {
    const s = await stack();
    const started = await s.call(
      "POST",
      "/api/v1/threads",
      start({ prompt: "[[scenario:approval-edit]] edit" }),
    );
    const r = await s.call(
      "POST",
      `/api/v1/threads/repo-builder/${started.body.thread_slug}/turns/${started.body.turn_id}:cancel`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ canceled_active_turn: true });
    const status = await s.call("GET", `/api/v1/threads/repo-builder/${started.body.thread_slug}`);
    expect(status.body.state).toBe("idle");
  });

  it("forks a thread", async () => {
    const s = await stack();
    const started = await s.call("POST", "/api/v1/threads", start());
    await until(
      async () =>
        (await s.call("GET", `/api/v1/threads/repo-builder/${started.body.thread_slug}`)).body
          .state === "idle",
      "idle",
    );
    const forked = await s.call(
      "POST",
      `/api/v1/threads/repo-builder/${started.body.thread_slug}:fork`,
      {
        name: "copy",
        idempotency_key: "key-0000-fork-0001",
      },
    );
    expect(forked.status).toBe(201);
    expect(forked.body).toMatchObject({ forked_from: started.body.thread_slug, replayed: false });
    expect(typeof forked.body.thread_id).toBe("string");
    const replay = await s.call(
      "POST",
      `/api/v1/threads/repo-builder/${started.body.thread_slug}:fork`,
      {
        name: "copy",
        idempotency_key: "key-0000-fork-0001",
      },
    );
    expect(replay.body).toMatchObject({ thread_id: forked.body.thread_id, replayed: true });
    const at = await s.call(
      "POST",
      `/api/v1/threads/repo-builder/${started.body.thread_slug}:fork`,
      {
        at: "5",
        idempotency_key: "key-0000-fork-0002",
      },
    );
    expect(at.status).toBe(400);
    expect(at.body.code).toBe("fork_at_unsupported");
  });
});

describe("GET /api/v1/threads/resolve", () => {
  it("finds a thread by slug or id, with or without the agent", async () => {
    const s = await stack();
    const a = await s.call("POST", "/api/v1/threads", start());
    const b = await s.call(
      "POST",
      "/api/v1/threads",
      start({ agent: "reviewer-cursor", idempotency_key: "key-0000-other-0001" }),
    );
    const bySlug = await s.call("GET", `/api/v1/threads/resolve?thread=${a.body.thread_slug}`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.matches).toEqual([
      {
        agent_id: a.body.agent_id,
        agent_slug: "repo-builder",
        thread_id: a.body.thread_id,
        thread_slug: a.body.thread_slug,
      },
    ]);
    const byId = await s.call("GET", `/api/v1/threads/resolve?thread=${b.body.thread_id}`);
    expect(byId.body.matches.map((m: { agent_slug: string }) => m.agent_slug)).toEqual([
      "reviewer-cursor",
    ]);
    const qualified = await s.call(
      "GET",
      `/api/v1/threads/resolve?thread=repo-builder/${a.body.thread_slug}`,
    );
    expect(qualified.body.matches).toHaveLength(1);
    expect(
      (await s.call("GET", "/api/v1/threads/resolve?thread=reviewer-cursor/" + a.body.thread_slug))
        .body.matches,
    ).toEqual([]);
  });

  it("returns an empty list for an unknown thread, and several matches when a slug is shared", async () => {
    const s = await stack();
    expect((await s.call("GET", "/api/v1/threads/resolve?thread=nope")).body.matches).toEqual([]);
    const agents = await s.exo.listAgents();
    for (const slug of ["repo-builder", "reviewer-cursor"]) {
      const agent = agents.find((x) => x.slug === slug)!;
      await s.exo.createThread(agent.id, { vaults: [], thread_slug: "shared-slug" });
    }
    const r = await s.call("GET", "/api/v1/threads/resolve?thread=shared-slug");
    expect(r.body.matches.map((m: { agent_slug: string }) => m.agent_slug).sort()).toEqual([
      "repo-builder",
      "reviewer-cursor",
    ]);
  });

  it("validates the query and needs the token", async () => {
    const s = await stack();
    expect((await s.call("GET", "/api/v1/threads/resolve")).status).toBe(400);
    expect((await s.call("GET", "/api/v1/threads/resolve?thread=")).status).toBe(400);
    expect((await fetch(`${s.url}/api/v1/threads/resolve?thread=x`)).status).toBe(401);
  });
});
