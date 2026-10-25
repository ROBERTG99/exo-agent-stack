import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit } from "@exos/stackd/db";
import { freshDb, tempDir } from "../db/helpers.ts";

const root = join(import.meta.dirname, "..", "..", "..");

function exos(args: string[], stateDir: string) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "cli/src/main.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EXOS_STATE_DIR: stateDir },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("exos audit verify", () => {
  it("exits 0 and reports the event count for an intact chain", () => {
    const { db, dir } = freshDb();
    for (let i = 0; i < 4; i++)
      appendAudit(db, { actor: "o", action: `a${i}`, target: "t", details: { i } });
    const r = exos(["audit", "verify"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/audit chain ok: 4 events/);
  });

  it("exits 0 for an empty chain", () => {
    const { dir } = freshDb();
    const r = exos(["audit", "verify"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/0 events/);
  });

  it("exits 1 and names the broken event when the chain was tampered with", () => {
    const { db, dir } = freshDb();
    for (let i = 0; i < 3; i++)
      appendAudit(db, { actor: "o", action: `a${i}`, target: "t", details: {} });
    db.exec("DROP TRIGGER audit_events_no_update");
    db.prepare("UPDATE audit_events SET actor = 'evil' WHERE seq = 2").run();
    const r = exos(["audit", "verify"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/audit chain BROKEN at event 2/);
  });

  it("prints machine-readable output with --json", () => {
    const { db, dir } = freshDb();
    appendAudit(db, { actor: "o", action: "a", target: "t", details: {} });
    const r = exos(["audit", "verify", "--json"], dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, count: 1 });
  });

  it("exits 2 when there is no database", () => {
    const r = exos(["audit", "verify"], tempDir());
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no database/i);
  });

  it("exits 2 with usage for an unknown command", () => {
    const r = exos(["nope"], tempDir());
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });
});
