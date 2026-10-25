import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitError,
  WorkspaceNotAllowedError,
  WorktreeConflictError,
  WorktreeManager,
} from "../../stackd/src/worktrees.ts";
import { freshDb } from "./db/helpers.ts";

const GIT_ENV = {
  PATH: process.env.PATH!,
  HOME: process.env.HOME!,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.org",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.org",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** A real git repository with one commit, inside an allowed root. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-root-")));
  const repo = join(root, "project");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# project\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "README.md", "src/a.ts");
  git(repo, "commit", "-q", "-m", "init");
  const { db } = freshDb();
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-base-")));
  const manager = new WorktreeManager(db, { baseDir, allowedRoots: [root] });
  return { root, repo, db, baseDir, manager };
}

describe("WorktreeManager.create", () => {
  it("adds a worktree on a new branch at the repository's HEAD", async () => {
    const { repo, baseDir, manager, db } = setup();
    const w = await manager.create({ threadSlug: "d-0123456789", workspace: repo });
    expect(w).toMatchObject({
      thread_slug: "d-0123456789",
      repo_path: repo,
      worktree_path: join(baseDir, "d-0123456789"),
      branch: "exos/d-0123456789",
      created: true,
    });
    expect(w.base_commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(w.worktree_path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("exos/d-0123456789");
    expect(readFileSync(join(w.worktree_path, "src", "a.ts"), "utf8")).toContain("a = 1");
    expect(
      db.prepare("SELECT thread_slug, repo_path, worktree_path, branch FROM worktrees").all(),
    ).toEqual([
      {
        thread_slug: "d-0123456789",
        repo_path: repo,
        worktree_path: join(baseDir, "d-0123456789"),
        branch: "exos/d-0123456789",
      },
    ]);
  });

  it("is idempotent for the same thread and workspace", async () => {
    const { repo, manager } = setup();
    const a = await manager.create({ threadSlug: "d-aaaaaaaaaa", workspace: repo });
    const b = await manager.create({ threadSlug: "d-aaaaaaaaaa", workspace: repo });
    expect(b).toMatchObject({
      created: false,
      worktree_path: a.worktree_path,
      branch: a.branch,
      base_commit: a.base_commit,
    });
  });

  it("refuses to reuse a thread slug for a different repository", async () => {
    const { root, repo, manager } = setup();
    await manager.create({ threadSlug: "d-bbbbbbbbbb", workspace: repo });
    const other = join(root, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "f"), "x");
    git(other, "add", "f");
    git(other, "commit", "-q", "-m", "init");
    await expect(
      manager.create({ threadSlug: "d-bbbbbbbbbb", workspace: other }),
    ).rejects.toBeInstanceOf(WorktreeConflictError);
  });

  it("gives two threads on one repository separate worktrees and branches", async () => {
    const { repo, manager } = setup();
    const a = await manager.create({ threadSlug: "d-1111111111", workspace: repo });
    const b = await manager.create({ threadSlug: "d-2222222222", workspace: repo });
    expect(a.worktree_path).not.toBe(b.worktree_path);
    expect(a.branch).not.toBe(b.branch);
    writeFileSync(join(a.worktree_path, "only-in-a.txt"), "a");
    expect(existsSync(join(b.worktree_path, "only-in-a.txt"))).toBe(false);
    expect(existsSync(join(repo, "only-in-a.txt"))).toBe(false);
  });

  it("handles concurrent creations on the same repository", async () => {
    const { repo, manager } = setup();
    const slugs = ["d-c000000001", "d-c000000002", "d-c000000003", "d-c000000004"];
    const results = await Promise.all(
      slugs.map((threadSlug) => manager.create({ threadSlug, workspace: repo })),
    );
    expect(new Set(results.map((r) => r.worktree_path)).size).toBe(4);
    for (const r of results) expect(existsSync(join(r.worktree_path, "README.md"))).toBe(true);
  });

  it("does not copy uncommitted changes from the source repository", async () => {
    const { repo, manager } = setup();
    writeFileSync(join(repo, "README.md"), "# edited, not committed\n");
    writeFileSync(join(repo, "untracked.txt"), "secret\n");
    const w = await manager.create({ threadSlug: "d-dddddddddd", workspace: repo });
    expect(readFileSync(join(w.worktree_path, "README.md"), "utf8")).toBe("# project\n");
    expect(existsSync(join(w.worktree_path, "untracked.txt"))).toBe(false);
  });

  it("neither runs the repository's hooks nor changes its git config", async () => {
    const { repo, manager } = setup();
    const marker = join(repo, "hook-ran");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const before = readFileSync(join(repo, ".git", "config"), "utf8");
    await manager.create({ threadSlug: "d-eeeeeeeeee", workspace: repo });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toBe(before);
  });

  it("ignores GIT_DIR and friends inherited from the server's environment", async () => {
    const { repo, manager } = setup();
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = "/nonexistent/.git";
    process.env.GIT_WORK_TREE = "/nonexistent";
    try {
      const w = await manager.create({ threadSlug: "d-ffffffffff", workspace: repo });
      expect(existsSync(join(w.worktree_path, "README.md"))).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("a repository's own configuration cannot run code on the host", () => {
  it("does not run a configured smudge filter while checking out the worktree", async () => {
    const { repo, root, manager } = setup();
    const marker = join(root, "filter-ran");
    const script = join(root, "smudge.sh");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    git(repo, "config", "filter.evil.smudge", script);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(repo, "x.txt"), "payload\n");
    git(repo, "add", ".gitattributes", "x.txt");
    git(repo, "commit", "-q", "-m", "add filtered file");
    expect(existsSync(marker)).toBe(false); // the commit itself uses the clean side only

    const w = await manager.create({ threadSlug: "d-9100000001", workspace: repo });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(w.worktree_path, "x.txt"), "utf8")).toBe("payload\n");
  });

  it("does not run a configured fsmonitor", async () => {
    const { repo, root, manager } = setup();
    const marker = join(root, "fsmonitor-ran");
    const script = join(root, "fsmonitor.sh");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    git(repo, "config", "core.fsmonitor", script);
    await manager.create({ threadSlug: "d-9100000002", workspace: repo });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("git metadata must also live inside the allowed roots", () => {
  it("rejects a repository whose git directory is elsewhere (gitfile pointing out)", async () => {
    const { root, db, baseDir } = setup();
    const gitdirHome = realpathSync(mkdtempSync(join(tmpdir(), "gitdir-")));
    const repo = join(root, "split");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main", "--separate-git-dir", join(gitdirHome, "meta.git"));
    writeFileSync(join(repo, "f"), "x");
    git(repo, "add", "f");
    git(repo, "commit", "-q", "-m", "init");
    const manager = new WorktreeManager(db, { baseDir, allowedRoots: [root] });
    await expect(
      manager.create({ threadSlug: "d-9200000001", workspace: repo }),
    ).rejects.toMatchObject({
      code: "workspace_not_allowed",
    });
    // Nothing was written into the outside git directory.
    expect(existsSync(join(gitdirHome, "meta.git", "worktrees"))).toBe(false);
  });

  it("accepts a workspace that is itself a linked worktree of a repository inside the roots", async () => {
    const { root, repo, manager } = setup();
    const linked = join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked);
    const w = await manager.create({ threadSlug: "d-9200000002", workspace: linked });
    expect(existsSync(join(w.worktree_path, "README.md"))).toBe(true);
  });
});

describe("workspace validation (workspace_not_allowed)", () => {
  it("rejects a repository outside every allowed root", async () => {
    const { manager } = setup();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
    git(elsewhere, "init", "-q");
    await expect(
      manager.create({ threadSlug: "d-1000000001", workspace: elsewhere }),
    ).rejects.toMatchObject({
      code: "workspace_not_allowed",
    });
  });

  it("rejects a symlink inside the root that points outside it", async () => {
    const { root, manager } = setup();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
    git(elsewhere, "init", "-q");
    symlinkSync(elsewhere, join(root, "link"));
    await expect(
      manager.create({ threadSlug: "d-1000000002", workspace: join(root, "link") }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
  });

  it("rejects .. traversal out of the root and relative paths", async () => {
    const { root, manager } = setup();
    await expect(
      manager.create({ threadSlug: "d-1000000003", workspace: join(root, "project", "..", "..") }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
    await expect(
      manager.create({ threadSlug: "d-1000000004", workspace: "project" }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
  });

  it("rejects a sibling directory whose name merely starts with the root's", async () => {
    const { root, manager } = setup();
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    git(sibling, "init", "-q");
    await expect(
      manager.create({ threadSlug: "d-1000000005", workspace: sibling }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
  });

  it("rejects a subdirectory whose repository root lies outside the allowed roots", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "outer-")));
    git(outer, "init", "-q", "-b", "main");
    writeFileSync(join(outer, "f"), "x");
    git(outer, "add", "f");
    git(outer, "commit", "-q", "-m", "init");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    const { db, baseDir } = setup();
    const manager = new WorktreeManager(db, { baseDir, allowedRoots: [inner] });
    await expect(
      manager.create({ threadSlug: "d-1000000006", workspace: inner }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
  });

  it("reports a missing directory and a non-repository separately", async () => {
    const { root, manager } = setup();
    await expect(
      manager.create({ threadSlug: "d-1000000007", workspace: join(root, "nope") }),
    ).rejects.toMatchObject({ code: "not_found" });
    const plain = join(root, "plain");
    mkdirSync(plain);
    await expect(
      manager.create({ threadSlug: "d-1000000008", workspace: plain }),
    ).rejects.toMatchObject({ code: "not_a_git_repo" });
  });

  it("an empty allowed-roots list allows nothing", async () => {
    const { repo, db, baseDir } = setup();
    const closed = new WorktreeManager(db, { baseDir, allowedRoots: [] });
    await expect(
      closed.create({ threadSlug: "d-1000000009", workspace: repo }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
  });

  it.each(["../x", "a/b", "", "d-", "x".repeat(129), "has space", "-flag"])(
    "rejects the thread slug %j",
    async (slug) => {
      const { repo, manager } = setup();
      await expect(manager.create({ threadSlug: slug, workspace: repo })).rejects.toThrow(/slug/i);
    },
  );

  it("refuses a repository inside the worktree base directory", async () => {
    const { repo, db } = setup();
    const manager = new WorktreeManager(db, { baseDir: join(repo, "wt"), allowedRoots: [repo] });
    mkdirSync(join(repo, "wt"));
    await expect(
      manager.create({ threadSlug: "d-2000000001", workspace: repo }),
    ).rejects.toBeInstanceOf(WorkspaceNotAllowedError);
  });
});

describe("WorktreeManager.get, list, remove, reconcile", () => {
  it("looks up and lists worktrees", async () => {
    const { repo, manager } = setup();
    await manager.create({ threadSlug: "d-3000000001", workspace: repo });
    await manager.create({ threadSlug: "d-3000000002", workspace: repo });
    expect(manager.get("d-3000000001")).toMatchObject({ branch: "exos/d-3000000001" });
    expect(manager.get("d-nope000000")).toBeUndefined();
    expect(manager.list().map((w) => w.thread_slug)).toEqual(["d-3000000001", "d-3000000002"]);
  });

  it("removes the worktree and its row but keeps the branch with its commits", async () => {
    const { repo, manager, db } = setup();
    const w = await manager.create({ threadSlug: "d-4000000001", workspace: repo });
    writeFileSync(join(w.worktree_path, "work.txt"), "work");
    git(w.worktree_path, "add", "work.txt");
    git(w.worktree_path, "commit", "-q", "-m", "agent work");
    expect(await manager.remove("d-4000000001")).toBe(true);
    expect(existsSync(w.worktree_path)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 0 });
    expect(git(repo, "branch", "--list", "exos/d-4000000001")).toContain("exos/d-4000000001");
    expect(git(repo, "log", "-1", "--format=%s", "exos/d-4000000001")).toBe("agent work");
  });

  it("refuses to remove a worktree with uncommitted changes unless forced", async () => {
    const { repo, manager } = setup();
    const w = await manager.create({ threadSlug: "d-4000000002", workspace: repo });
    writeFileSync(join(w.worktree_path, "dirty.txt"), "unsaved");
    await expect(manager.remove("d-4000000002")).rejects.toBeInstanceOf(GitError);
    expect(existsSync(w.worktree_path)).toBe(true);
    expect(await manager.remove("d-4000000002", { force: true })).toBe(true);
    expect(existsSync(w.worktree_path)).toBe(false);
  });

  it("returns false when there is nothing to remove", async () => {
    const { manager } = setup();
    expect(await manager.remove("d-5000000000")).toBe(false);
  });

  it("lets a thread slug be created again after removal", async () => {
    const { repo, manager } = setup();
    await manager.create({ threadSlug: "d-6000000001", workspace: repo });
    await manager.remove("d-6000000001");
    const again = await manager.create({ threadSlug: "d-6000000001", workspace: repo });
    expect(again.created).toBe(true);
    expect(existsSync(again.worktree_path)).toBe(true);
  });

  it("reconcile reports rows whose directory disappeared", async () => {
    const { repo, manager } = setup();
    const a = await manager.create({ threadSlug: "d-7000000001", workspace: repo });
    await manager.create({ threadSlug: "d-7000000002", workspace: repo });
    execFileSync("rm", ["-rf", a.worktree_path]);
    expect(await manager.reconcile()).toEqual({ missing: ["d-7000000001"] });
  });

  it("recreates a missing worktree directory for a known thread on create", async () => {
    const { repo, manager } = setup();
    const a = await manager.create({ threadSlug: "d-8000000001", workspace: repo });
    execFileSync("rm", ["-rf", a.worktree_path]);
    const again = await manager.create({ threadSlug: "d-8000000001", workspace: repo });
    expect(again.created).toBe(false);
    expect(existsSync(join(again.worktree_path, "README.md"))).toBe(true);
  });
});
