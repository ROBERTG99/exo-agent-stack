import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  DEFAULT_DASHBOARD_ONLY,
  isDashboardOnly,
  isOpen,
  loadDashboardOnly,
  parseDashboardOnly,
  redactArgs,
} from "../../stackd/src/approvals.ts";
import { freshDb } from "./db/helpers.ts";

describe("redactArgs", () => {
  it("masks secret-looking keys and values anywhere in the arguments", () => {
    const out = JSON.parse(
      redactArgs({
        command: "curl -H 'Authorization: Bearer abcdefghijkl' https://example.org",
        env: {
          API_KEY: "sk-ant-abcdefgh12345678",
          PATH: "/usr/bin",
          nested: { password: "hunter2" },
        },
        list: ["ghp_abcdefghijklmnopqrstu", "fine"],
        note: "token is xoxb-1234567890-abc",
      }),
    );
    expect(out.command).toBe("curl -H 'Authorization: [redacted]' https://example.org");
    expect(out.env).toEqual({
      API_KEY: "[redacted]",
      PATH: "/usr/bin",
      nested: { password: "[redacted]" },
    });
    expect(out.list).toEqual(["[redacted]", "fine"]);
    expect(out.note).toBe("token is [redacted]");
  });

  it("cuts long strings and bounds the whole document", () => {
    const long = JSON.parse(redactArgs({ text: "x".repeat(2000) })).text as string;
    expect(long.startsWith("x".repeat(500))).toBe(true);
    expect(long).toContain("(2000 chars)");
    const huge = redactArgs(
      Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "y".repeat(400)])),
    );
    expect(huge.length).toBeLessThanOrEqual(4100);
    expect(JSON.parse(huge)).toBeTypeOf("object");
  });

  it("is canonical, handles non-objects and deep structures", () => {
    expect(redactArgs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(redactArgs(undefined)).toBe("{}");
    expect(redactArgs("plain")).toBe('"plain"');
    let deep: unknown = "end";
    for (let i = 0; i < 10; i++) deep = { x: deep };
    expect(redactArgs(deep)).toContain("[too deep]");
  });
});

describe("dashboard-only matching", () => {
  const m = parseDashboardOnly(DEFAULT_DASHBOARD_ONLY);
  const bash = (command: string) => isDashboardOnly(m, "claude.Bash", { command });

  it("catches git push, npm publish and network commands anywhere in a command", () => {
    for (const c of [
      "git push origin main",
      "cd repo && git push --force",
      "npm publish --access public",
      "curl https://example.org",
      "wget -q x",
      "ssh host",
      'echo "git push"',
    ]) {
      expect(bash(c), c).toBe(true);
    }
  });

  it("matches a phrase as a word: `ssh` is not `-c gpg.ssh.program=false`, but still `/usr/bin/ssh host`", () => {
    for (const c of ["ssh host", "/usr/bin/ssh host", "cd x && ssh host", "echo a; ssh -p 22 h"]) {
      expect(bash(c), c).toBe(true);
    }
    for (const c of ["git -c gpg.ssh.program=false log", "echo a.ssh=b", "ls sshd"]) {
      // a tool that is not Bash, so only the phrase matcher decides
      expect(isDashboardOnly(parseDashboardOnly(["*(ssh)"]), "mcp.run", { command: c }), c).toBe(
        false,
      );
    }
    for (const c of ["ssh host", "run ssh -p 22 h", "/usr/bin/ssh h"]) {
      expect(isDashboardOnly(parseDashboardOnly(["*(ssh)"]), "mcp.run", { command: c }), c).toBe(
        true,
      );
    }
  });

  it("lets plainly harmless commands through, and sends everything it cannot vouch for to the dashboard", () => {
    for (const c of [
      "ls -la",
      "git --no-pager -c core.fsmonitor=false -c gpg.program=false -c gpg.x509.program=false -c gpg.ssh.program=false log --no-ext-diff --no-textconv --oneline",
      "cat README.md",
    ]) {
      expect(bash(c), c).toBe(false);
    }
    for (const c of [
      "git commit -m x",
      "git status",
      "pnpm test",
      "make check-fast",
      "echo x > Makefile",
      "npm install",
      "git -c core.sshCommand=x push",
      "/usr/bin/git  push",
      "python3 -c 'import socket'",
      "echo $(id)",
    ]) {
      expect(bash(c), c).toBe(true);
    }
  });

  it("treats a shell call with no readable command as dashboard-only", () => {
    expect(isDashboardOnly([], "claude.Bash", undefined)).toBe(true);
    expect(isDashboardOnly([], "claude.Bash", { command: 5 })).toBe(true);
    expect(isDashboardOnly([], "Bash", { command: "rm -rf build" })).toBe(true);
    expect(isDashboardOnly([], "claude.Bash", { command: "ls" })).toBe(false);
  });

  it("matches network tools by name and ignores other tools", () => {
    expect(isDashboardOnly(m, "claude.WebFetch", { url: "https://example.org" })).toBe(true);
    expect(isDashboardOnly(m, "claude.WebSearch", {})).toBe(true);
    expect(isDashboardOnly(m, "claude.Edit", { file_path: "a.ts" })).toBe(false);
  });

  it("supports a whole-name glob and escapes regex characters", () => {
    const glob = parseDashboardOnly(["mcp.*", "claude.Bash(a+b)"]);
    expect(isDashboardOnly(glob, "mcp.github.create_issue", {})).toBe(true);
    expect(isDashboardOnly(glob, "claude.Bash", { command: "echo a+b" })).toBe(true);
    expect(isDashboardOnly(glob, "claude.Bash", { command: "echo aab" })).toBe(false);
  });

  it("reads the list from the environment, comma separated, with a non-empty default", () => {
    expect(loadDashboardOnly({})).toEqual(DEFAULT_DASHBOARD_ONLY);
    expect(loadDashboardOnly({ EXOS_APPROVE_DASHBOARD_ONLY: "  " })).toEqual(
      DEFAULT_DASHBOARD_ONLY,
    );
    expect(loadDashboardOnly({ EXOS_APPROVE_DASHBOARD_ONLY: "a, b(c)" })).toEqual(["a", "b(c)"]);
    expect(DEFAULT_DASHBOARD_ONLY.length).toBeGreaterThan(0);
  });
});

// --- the queue against a stub Exo ---------------------------------------------------------------

type Ev = Record<string, unknown> & { id: string; type: string };

function setup(events: Ev[]) {
  const { db } = freshDb();
  const exo = {
    listThreads: async () => ({ threads: [{ id: "thr_1", slug: "d-abc" }], next_cursor: null }),
    listEvents: async (_a: string, _t: string, q: { after?: string; limit?: number }) => {
      const at = q.after === undefined ? -1 : events.findIndex((e) => e.id === q.after);
      return events.slice(at + 1, at + 1 + (q.limit ?? 200));
    },
  };
  const agents = { list: async () => [{ id: "agt_1", slug: "a", mode: "A" }] };
  let now = new Date("2026-10-25T10:00:00Z");
  const queue = new ApprovalQueue({
    db,
    exo: exo as never,
    agents: agents as never,
    dashboardOnly: DEFAULT_DASHBOARD_ONLY,
    clock: () => now,
  });
  return { db, queue, events, setNow: (d: Date) => (now = d) };
}

const request = (id: string, tool: string, args: unknown, turn = "trn_1", n = id): Ev => ({
  id: n,
  type: "agent_runtime.approval_requested",
  approval_id: id,
  tool,
  arguments: args,
  turn_id: turn,
  session_id: "ses_1",
  call_id: `call_${id}`,
  ts: "2026-10-25T09:00:00.000Z",
});

describe("ApprovalQueue.sync", () => {
  it("adds requests as open rows, marks dashboard-only ones and redacts arguments", async () => {
    const { queue } = setup([
      request("apr_1", "claude.Edit", { file_path: "a.ts", token: "secret" }, "trn_1", "1"),
      request("apr_2", "claude.Bash", { command: "git push" }, "trn_1", "2"),
    ]);
    expect(await queue.sync()).toEqual({ added: 2, closed: 0 });
    const rows = queue.list({ state: "open" });
    expect(rows.map((r) => [r.approval_id, r.decision, r.thread_slug, r.agent_id])).toEqual([
      ["apr_1", "pending", "d-abc", "agt_1"],
      ["apr_2", "dashboard_only", "d-abc", "agt_1"],
    ]);
    expect(JSON.parse(rows[0]!.args_redacted)).toEqual({ file_path: "a.ts", token: "[redacted]" });
    expect(rows.every((r) => isOpen(r.decision))).toBe(true);
  });

  it("reads each event once: a second pass adds nothing and uses the cursor", async () => {
    const { queue, db, events } = setup([request("apr_1", "claude.Edit", {}, "trn_1", "1")]);
    await queue.sync();
    expect(await queue.sync()).toEqual({ added: 0, closed: 0 });
    events.push(request("apr_2", "claude.Edit", {}, "trn_1", "2"));
    expect(await queue.sync()).toEqual({ added: 1, closed: 0 });
    expect(db.prepare("SELECT last_event_id FROM approval_cursors").get()).toEqual({
      last_event_id: "2",
    });
  });

  it("closes a request when Exo's log shows the response, whatever it was", async () => {
    const { queue } = setup([
      request("apr_1", "claude.Edit", {}, "trn_1", "1"),
      request("apr_2", "claude.Edit", {}, "trn_1", "2"),
      request("apr_3", "claude.Edit", {}, "trn_1", "3"),
      { id: "4", type: "agent_runtime.approval_response", approval_id: "apr_1", approved: true },
      { id: "5", type: "agent_runtime.approval_response", approval_id: "apr_2", approved: false },
      {
        id: "6",
        type: "agent_runtime.approval_response",
        approval_id: "apr_3",
        approved: true,
        allow_for_tool: true,
      },
    ]);
    expect((await queue.sync()).closed).toBe(3);
    expect(
      queue.list({ state: "decided" }).map((r) => [r.approval_id, r.decision, r.decided_by]),
    ).toEqual([
      ["apr_1", "approved", "exo"],
      ["apr_2", "denied", "exo"],
      ["apr_3", "approved_for_session", "exo"],
    ]);
    expect(queue.list({ state: "open" })).toEqual([]);
  });

  it("tracks client-tool questions and closes them on the result", async () => {
    const { queue } = setup([
      {
        id: "1",
        type: "frontend_tool_requested",
        call_id: "call_9",
        name: "ask_user",
        turn_id: "trn_1",
        session_id: "ses_1",
        arguments: { question: "Which environment?", choices: ["a", "b"] },
      },
    ]);
    await queue.sync();
    const [row] = queue.list({ state: "open" });
    expect(row).toMatchObject({
      kind: "frontend",
      approval_id: "ft:thr_1:call_9",
      call_id: "call_9",
      untrusted_text: "Which environment?",
    });
    expect(queue.frontendByCall("call_9")).toHaveLength(1);
    expect(queue.frontendByCall("call_9", "other-thread")).toHaveLength(0);
  });

  it("closes the open requests of a turn that ended", async () => {
    const { queue } = setup([
      request("apr_1", "claude.Edit", {}, "trn_1", "1"),
      request("apr_2", "claude.Edit", {}, "trn_2", "2"),
      { id: "3", type: "turn_ended", turn_id: "trn_1", status: "canceled" },
    ]);
    await queue.sync();
    expect(queue.list({ state: "open" }).map((r) => r.approval_id)).toEqual(["apr_2"]);
    expect(queue.get("apr_1")).toMatchObject({ decision: "denied", decided_by: "turn_ended" });
  });

  it("ignores requests without an id and unknown event types", async () => {
    const { queue } = setup([
      { id: "1", type: "agent_runtime.approval_requested", tool: "x" },
      { id: "2", type: "frontend_tool_requested", name: "ask_user" },
      { id: "3", type: "something_new" },
    ]);
    expect(await queue.sync()).toEqual({ added: 0, closed: 0 });
  });
});

describe("ApprovalQueue.claim and release", () => {
  it("lets exactly one claimant decide, and puts a row back for a retry", async () => {
    const { queue } = setup([
      request("apr_1", "claude.Bash", { command: "git push" }, "trn_1", "1"),
    ]);
    await queue.sync();
    expect(queue.claim("apr_1", "approved", "dashboard")).toBe(true);
    expect(queue.claim("apr_1", "denied", "api")).toBe(false);
    expect(queue.get("apr_1")).toMatchObject({ decision: "approved", decided_by: "dashboard" });
    queue.release("apr_1", "dashboard_only");
    expect(queue.get("apr_1")).toMatchObject({
      decision: "dashboard_only",
      decided_by: null,
      decided_at: null,
    });
    expect(queue.claim("apr_1", "denied", "dashboard")).toBe(true);
  });

  it("filters by thread and state", async () => {
    const { queue } = setup([request("apr_1", "claude.Edit", {}, "trn_1", "1")]);
    await queue.sync();
    expect(queue.list({ state: "open", thread: "d-abc" })).toHaveLength(1);
    expect(queue.list({ state: "open", thread: "thr_1" })).toHaveLength(1);
    expect(queue.list({ state: "open", thread: "nope" })).toHaveLength(0);
    expect(queue.list({ state: "all" })).toHaveLength(1);
    expect(queue.list({ state: "decided" })).toHaveLength(0);
  });
});
