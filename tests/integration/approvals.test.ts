/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are schemaless in this suite */
// T-27: the approvals queue (BUILD.md §4.6, FR-11) against the Exo simulator.
import { afterEach, describe, expect, it } from "vitest";
import { startStack, until, type Stack } from "../helpers/stack.ts";

const stacks: Stack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});
async function stack() {
  const s = await startStack();
  stacks.push(s);
  return s;
}

let n = 0;
const key = () => `key-appr-${String(++n).padStart(7, "0")}`;

async function startThread(s: Stack, prompt: string) {
  const r = await s.call("POST", "/api/v1/threads", {
    agent: "repo-builder",
    prompt,
    idempotency_key: key(),
  });
  expect(r.status).toBe(201);
  return r.body;
}

/** A call as the dashboard makes it: with the session cookie from /login, not the bearer token. */
async function dashboard(s: Stack) {
  const login = await fetch(`${s.url}/login?t=${s.stackd.dashboardToken}`, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${s.url}${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
}

const openApprovals = async (s: Stack, q = "") =>
  (await s.call("GET", `/api/v1/approvals${q}`)).body.approvals as any[];
const waitOpen = (s: Stack, what: string) =>
  until(async () => {
    const list = await openApprovals(s);
    return list.length > 0 ? list : undefined;
  }, what);
const turnDone = (s: Stack, t: any) =>
  until(
    async () =>
      (await s.call("GET", `/api/v1/threads/repo-builder/${t.thread_slug}`)).body.state === "idle",
    "the turn to end",
  );
const toolResults = async (s: Stack, t: any) =>
  (
    await s.call(
      "GET",
      `/api/v1/threads/repo-builder/${t.thread_slug}/events?types=tool_result&limit=50`,
    )
  ).body.events;

describe("listing", () => {
  it("shows an open tool approval with redacted arguments and where it came from", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    expect(a).toMatchObject({
      kind: "approval",
      tool: "claude.Edit",
      args: { file_path: "notes.md" },
      decision: "pending",
      dashboard_only: false,
      thread_slug: t.thread_slug,
      turn_id: t.turn_id,
      agent: "repo-builder",
      decided_by: null,
    });
    expect(a.dashboard_url).toContain(t.thread_slug);
  });

  it("masks secrets in the arguments before storing them", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:plain]] hi");
    await turnDone(s, t);
    s.sim.store.addEvent(t.thread_id, {
      type: "agent_runtime.approval_requested",
      turn_id: "trn_synthetic",
      session_id: "ses_x",
      payload: {
        approval_id: "apr_secret",
        tool: "claude.Bash",
        call_id: "c1",
        arguments: { command: "echo hi", API_KEY: "sk-ant-abcdefgh12345678" },
      },
    });
    const list = await openApprovals(s);
    expect(list[0].args).toEqual({ API_KEY: "[redacted]", command: "echo hi" });
    const stored = s.stackd.db.prepare("SELECT args_redacted FROM approvals").get() as {
      args_redacted: string;
    };
    expect(stored.args_redacted).not.toContain("sk-ant");
  });

  it("returns what it last knew, flagged stale, when Exo is down", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:approval-edit]] edit");
    await waitOpen(s, "the approval");
    await s.stopExo();
    const r = await s.call("GET", "/api/v1/approvals");
    expect(r.status).toBe(200);
    expect(r.body.stale).toBe(true);
    expect(r.body.approvals).toHaveLength(1);
  });

  it("closes the requests of a turn that was cancelled", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    await s.call("POST", `/api/v1/threads/repo-builder/${t.thread_slug}/turns/${t.turn_id}:cancel`);
    expect(await openApprovals(s)).toEqual([]);
    const decided = await openApprovals(s, "?state=decided");
    expect(decided[0]).toMatchObject({
      approval_id: a.approval_id,
      decision: "denied",
      decided_by: "turn_ended",
    });
    const late = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve",
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("already_decided");
  });
});

describe("deciding", () => {
  it("approves, which resumes the turn in Exo and records who decided", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    const r = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve",
      reason: "looks fine",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approval_id: a.approval_id, decision: "approved" });
    expect(typeof r.body.recorded_event_id).toBe("string");
    await turnDone(s, t);
    expect(JSON.parse((await toolResults(s, t))[0].untrusted_text)).toEqual({ approved: true });
    const decided = await openApprovals(s, "?state=decided");
    expect(decided[0]).toMatchObject({ decision: "approved", decided_by: "api" });
    const audit = s.stackd.db
      .prepare("SELECT actor, target FROM audit_events WHERE action = 'approval.decide'")
      .get();
    expect(audit).toEqual({ actor: "api", target: a.approval_id });
  });

  it("denies", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    const r = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "deny",
    });
    expect(r.body.decision).toBe("denied");
    await turnDone(s, t);
    expect(JSON.parse((await toolResults(s, t))[0].untrusted_text)).toEqual({ approved: false });
  });

  it("approves for the session by telling Exo to allow the tool", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    const r = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve_for_session",
    });
    expect(r.body.decision).toBe("approved_for_session");
    const row = s.sim.store.pending(a.approval_id)!;
    expect(row.decision).toEqual({ approved: true, allow_for_tool: true });
  });

  it("answers 409 to a second decision and 404 to an unknown request", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    expect(
      (await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, { decision: "approve" }))
        .status,
    ).toBe(200);
    const again = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "deny",
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_decided");
    expect(
      (await s.call("POST", "/api/v1/approvals/apr_nope:decide", { decision: "approve" })).status,
    ).toBe(404);
    expect(
      (await s.call("POST", `/api/v1/approvals/${a.approval_id}:other`, { decision: "approve" }))
        .status,
    ).toBe(404);
    expect(
      (await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, { decision: "maybe" }))
        .status,
    ).toBe(400);
  });

  it("replays a decision made with an idempotency key and refuses a different body", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:approval-edit]] edit");
    const [a] = await waitOpen(s, "the approval");
    const k = key();
    const first = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve",
      idempotency_key: k,
    });
    const second = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve",
      idempotency_key: k,
    });
    expect(first.body).toMatchObject({ decision: "approved", replayed: false });
    expect(second.body).toMatchObject({
      approval_id: a.approval_id,
      decision: "approved",
      replayed: true,
      recorded_event_id: first.body.recorded_event_id,
    });
    const clash = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "deny",
      idempotency_key: k,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("idempotency_conflict");
  });
});

describe("dashboard-only tools (FR-11)", () => {
  it("refuses the bridge, keeps the request pending, and lets the dashboard approve it", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:approval-git-push]] push");
    const [a] = await waitOpen(s, "the approval");
    expect(a).toMatchObject({
      tool: "claude.Bash",
      decision: "dashboard_only",
      dashboard_only: true,
    });

    const refused = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve",
      idempotency_key: key(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("dashboard_only");
    expect(s.sim.store.pending(a.approval_id)!.status).toBe("pending");
    expect((await openApprovals(s))[0]).toMatchObject({
      approval_id: a.approval_id,
      decision: "dashboard_only",
    });
    const refusal = s.stackd.db
      .prepare("SELECT actor FROM audit_events WHERE action = 'approval.refused_dashboard_only'")
      .get();
    expect(refusal).toEqual({ actor: "api" });

    const web = await dashboard(s);
    const noSession = await web("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve_for_session",
    });
    expect(noSession.status).toBe(400);
    const ok = await web("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "approve",
    });
    expect(ok.status).toBe(200);
    await turnDone(s, t);
    expect((await openApprovals(s, "?state=decided"))[0]).toMatchObject({
      decision: "approved",
      decided_by: "dashboard",
    });
  });

  it("refuses the bridge for a denial too: only the dashboard decides these", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:approval-git-push]] push");
    const [a] = await waitOpen(s, "the approval");
    const r = await s.call("POST", `/api/v1/approvals/${a.approval_id}:decide`, {
      decision: "deny",
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("dashboard_only");
  });
});

describe("questions for the human", () => {
  it("lists the question as untrusted text and answers it through the queue", async () => {
    const s = await stack();
    const t = await startThread(s, "[[scenario:ask-user]] ask");
    const [q] = await waitOpen(s, "the question");
    expect(q).toMatchObject({
      kind: "frontend",
      tool: "ask_user",
      untrusted_text: "Which environment should I use?",
    });
    expect(q.args.choices).toEqual(["staging", "production-copy"]);

    const r = await s.call("POST", `/api/v1/frontend-tools/${q.call_id}:answer`, {
      answer: "staging",
      idempotency_key: key(),
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.recorded_event_id).toBe("string");
    await turnDone(s, t);
    expect((await toolResults(s, t))[0].untrusted_text).toBe("staging");
    expect(await openApprovals(s)).toEqual([]);
    const again = await s.call("POST", `/api/v1/frontend-tools/${q.call_id}:answer`, {
      answer: "staging",
    });
    expect(again.status).toBe(404);
  });

  it("does not store the answer, only its length and hash, in the audit log", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:ask-user]] ask");
    const [q] = await waitOpen(s, "the question");
    await s.call("POST", `/api/v1/frontend-tools/${q.call_id}:answer`, {
      answer: "very private answer",
    });
    const row = s.stackd.db
      .prepare("SELECT details_json FROM audit_events WHERE action = 'frontend_tool.answer'")
      .get() as { details_json: string };
    expect(row.details_json).not.toContain("very private answer");
    expect(JSON.parse(row.details_json)).toMatchObject({ answer_chars: 19 });
  });

  it("validates the answer and the verb", async () => {
    const s = await stack();
    await startThread(s, "[[scenario:ask-user]] ask");
    const [q] = await waitOpen(s, "the question");
    expect(
      (await s.call("POST", `/api/v1/frontend-tools/${q.call_id}:answer`, { answer: "" })).status,
    ).toBe(400);
    expect(
      (await s.call("POST", `/api/v1/frontend-tools/${q.call_id}:other`, { answer: "x" })).status,
    ).toBe(404);
    expect(
      (await s.call("POST", `/api/v1/approvals/${q.approval_id}:decide`, { decision: "approve" }))
        .status,
    ).toBe(400);
  });
});

describe("sessions", () => {
  it("signs the dashboard in with its own token, as an HttpOnly SameSite=Strict cookie", async () => {
    const s = await stack();
    const login = await fetch(`${s.url}/login?t=${s.stackd.dashboardToken}`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^exos_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(cookie).not.toContain(s.stackd.dashboardToken);
    expect(cookie).not.toContain(s.token);
    expect(login.headers.get("location")).toContain("127.0.0.1:9800");
    expect(login.headers.get("cache-control")).toBe("no-store");
    const ok = await fetch(`${s.url}/api/v1/approvals`, {
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(ok.status).toBe(200);
  });

  it("does not let the API token (the bridge's) mint a dashboard session", async () => {
    const s = await stack();
    expect(s.stackd.dashboardToken).not.toBe(s.token);
    const attempt = await fetch(`${s.url}/login?t=${s.token}`, { redirect: "manual" });
    expect(attempt.status).toBe(401);
    expect(attempt.headers.get("set-cookie")).toBeNull();
    // and the dashboard token is not a bearer
    const asBearer = await fetch(`${s.url}/api/v1/approvals`, {
      headers: { authorization: `Bearer ${s.stackd.dashboardToken}` },
    });
    expect(asBearer.status).toBe(401);
  });

  it("keeps the two tokens in separate owner-only files", async () => {
    const s = await stack();
    const { statSync } = await import("node:fs");
    for (const f of ["local-token", "dashboard-token"]) {
      expect(statSync(`${s.stateDir}/${f}`).mode & 0o777, f).toBe(0o600);
    }
  });

  it("refuses a wrong login token, a forged cookie and a wrong bearer", async () => {
    const s = await stack();
    expect((await fetch(`${s.url}/login?t=${"0".repeat(64)}`, { redirect: "manual" })).status).toBe(
      401,
    );
    expect((await fetch(`${s.url}/login`, { redirect: "manual" })).status).toBe(401);
    const forged = await fetch(`${s.url}/api/v1/approvals`, {
      headers: { cookie: `exos_session=${"a".repeat(64)}` },
    });
    expect(forged.status).toBe(401);
    const login = await fetch(`${s.url}/login?t=${s.stackd.dashboardToken}`, {
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const bad = await fetch(`${s.url}/api/v1/approvals`, {
      headers: { authorization: "Bearer nope", cookie },
    });
    expect(bad.status).toBe(401); // a presented bearer is judged on its own
  });
});
