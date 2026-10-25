// One git worktree per delegated thread (BUILD.md §3.1 FR-4, §4.4 `worktrees`): the Mode A agent
// runs in, and only sees, its own checkout. The workspace a caller names must resolve (through
// symlinks) inside EXOS_ALLOWED_WORKSPACE_ROOTS, and so must its repository root.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db/connection.ts";

const run = promisify(execFile);

export class WorkspaceNotAllowedError extends Error {
  readonly code = "workspace_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceNotAllowedError";
  }
}

export class WorkspaceError extends Error {
  constructor(
    readonly code: "not_found" | "not_a_git_repo",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class WorktreeConflictError extends Error {
  readonly code = "worktree_conflict";
  constructor(message: string) {
    super(message);
    this.name = "WorktreeConflictError";
  }
}

export class GitError extends Error {
  readonly code = "git_failed";
  constructor(
    message: string,
    readonly stderr: string,
    /** The process exit status, or undefined for a timeout/signal/other spawn failure. */
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface WorktreeRow {
  thread_slug: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
  base_commit: string;
}

export interface Worktree extends WorktreeRow {
  /** False when the worktree for this thread already existed. */
  created: boolean;
}

export interface WorktreeManagerOptions {
  /** Directory the worktrees are created in (under the state directory). */
  baseDir: string;
  allowedRoots: string[];
}

const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9_])?$/;

const inside = (child: string, root: string): boolean =>
  child === root || child.startsWith(root + path.sep);

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export class WorktreeManager {
  private readonly baseDir: string;
  private readonly roots: string[];
  /** The roots as given: a caller may name a root through a symlink alias (macOS /var). */
  private readonly lexicalRoots: string[];
  /** Serialises git operations per repository: `git worktree add` takes locks in the shared .git. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    opts: WorktreeManagerOptions,
  ) {
    this.baseDir = real(opts.baseDir);
    this.roots = opts.allowedRoots.map(real);
    this.lexicalRoots = opts.allowedRoots.map((r) => path.resolve(r));
  }

  get(threadSlug: string): WorktreeRow | undefined {
    return this.db.prepare("SELECT * FROM worktrees WHERE thread_slug = ?").get(threadSlug) as
      WorktreeRow | undefined;
  }

  list(): WorktreeRow[] {
    return this.db.prepare("SELECT * FROM worktrees ORDER BY thread_slug").all() as WorktreeRow[];
  }

  async create(input: { threadSlug: string; workspace: string }): Promise<Worktree> {
    const slug = input.threadSlug;
    if (!SLUG.test(slug)) throw new Error(`invalid thread slug ${JSON.stringify(slug)}`);
    const repo = await this.resolveRepository(input.workspace);
    return this.exclusive(repo, async () => {
      const known = this.get(slug);
      if (known) {
        if (known.repo_path !== repo) {
          throw new WorktreeConflictError(
            `thread ${slug} already has a worktree of another repository`,
          );
        }
        if (!existsSync(known.worktree_path)) {
          // The directory was deleted from outside; bring the same branch back.
          await this.git(repo, ["worktree", "prune"]);
          await this.addWorktree(repo, known.worktree_path, [
            "worktree",
            "add",
            "--no-checkout",
            "--",
            known.worktree_path,
            known.branch,
          ]);
        }
        return { ...known, created: false };
      }

      const branch = `exos/${slug}`;
      const worktreePath = path.join(this.baseDir, slug);
      mkdirSync(this.baseDir, { recursive: true });
      if (existsSync(worktreePath))
        throw new WorktreeConflictError(`${worktreePath} already exists`);

      const branchExists = await this.gitOk(repo, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      // A removed thread keeps its branch; creating the slug again continues from it.
      const args = branchExists
        ? ["worktree", "add", "--no-checkout", "--", worktreePath, branch]
        : ["worktree", "add", "--no-checkout", "-b", branch, "--", worktreePath, "HEAD"];
      await this.addWorktree(repo, worktreePath, args);
      try {
        const base = (await this.git(worktreePath, ["rev-parse", "HEAD"])).trim();
        this.db
          .prepare(
            "INSERT INTO worktrees (thread_slug, repo_path, worktree_path, branch, base_commit) VALUES (?, ?, ?, ?, ?)",
          )
          .run(slug, repo, worktreePath, branch, base);
        return {
          thread_slug: slug,
          repo_path: repo,
          worktree_path: worktreePath,
          branch,
          base_commit: base,
          created: true,
        };
      } catch (err) {
        await this.git(repo, ["worktree", "remove", "--force", "--", worktreePath]).catch(
          () => undefined,
        );
        throw err;
      }
    });
  }

  /**
   * Removes the worktree and its row; the branch and its commits are kept. A worktree with
   * uncommitted changes is refused unless `force` is set.
   */
  async remove(threadSlug: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const row = this.get(threadSlug);
    if (!row) return false;
    await this.exclusive(row.repo_path, async () => {
      if (existsSync(row.worktree_path)) {
        await this.git(row.repo_path, [
          "worktree",
          "remove",
          ...(opts.force ? ["--force"] : []),
          "--",
          row.worktree_path,
        ]);
      } else {
        await this.git(row.repo_path, ["worktree", "prune"]);
      }
      this.db.prepare("DELETE FROM worktrees WHERE thread_slug = ?").run(threadSlug);
    });
    return true;
  }

  /** Threads whose worktree directory no longer exists. */
  async reconcile(): Promise<{ missing: string[] }> {
    return {
      missing: this.list()
        .filter((w) => !existsSync(w.worktree_path))
        .map((w) => w.thread_slug),
    };
  }

  // --- workspace validation ------------------------------------------------------------------

  /** Throws WorkspaceNotAllowedError unless `p` (lexically and after symlinks) is inside an allowed root. */
  assertPathAllowed(p: string): string {
    if (!path.isAbsolute(p)) throw new WorkspaceNotAllowedError("path must be absolute");
    const lexical = path.resolve(p);
    if (!this.allowedLexically(lexical))
      throw new WorkspaceNotAllowedError(`${p} is outside the allowed workspace roots`);
    const resolved = real(lexical);
    if (!this.allowed(resolved))
      throw new WorkspaceNotAllowedError(`${p} resolves outside the allowed workspace roots`);
    return resolved;
  }

  private async resolveRepository(workspace: string): Promise<string> {
    if (!path.isAbsolute(workspace))
      throw new WorkspaceNotAllowedError("workspace must be an absolute path");
    const lexical = path.resolve(workspace);
    if (!this.allowedLexically(lexical))
      throw new WorkspaceNotAllowedError(`${workspace} is outside the allowed workspace roots`);

    let resolved: string;
    try {
      resolved = realpathSync(lexical);
    } catch {
      throw new WorkspaceError("not_found", `${workspace} does not exist`);
    }
    if (!this.allowed(resolved)) {
      throw new WorkspaceNotAllowedError(
        `${workspace} resolves outside the allowed workspace roots`,
      );
    }
    if (inside(resolved, this.baseDir) || inside(this.baseDir, resolved)) {
      throw new WorkspaceNotAllowedError(
        "the workspace and the worktree directory must not contain each other",
      );
    }

    let top: string;
    try {
      top = realpathSync((await this.git(resolved, ["rev-parse", "--show-toplevel"])).trim());
    } catch (err) {
      if (err instanceof GitError && /not a git repository/i.test(err.stderr)) {
        throw new WorkspaceError("not_a_git_repo", `${workspace} is not inside a git repository`);
      }
      throw err;
    }
    if (!this.allowed(top)) {
      throw new WorkspaceNotAllowedError(
        `the repository root ${top} is outside the allowed workspace roots`,
      );
    }
    // `git worktree add` writes metadata into the git directory, which a gitfile or
    // --separate-git-dir can place anywhere: it must be inside the roots too.
    for (const flag of [["--absolute-git-dir"], ["--path-format=absolute", "--git-common-dir"]]) {
      const dir = realpathSync((await this.git(resolved, ["rev-parse", ...flag])).trim());
      if (!this.allowed(dir)) {
        throw new WorkspaceNotAllowedError(
          `the git directory ${dir} is outside the allowed workspace roots`,
        );
      }
    }
    return top;
  }

  /**
   * Adds the worktree without checking anything out (so no filter, hook or fsmonitor can run yet),
   * then populates it with every configured filter driver neutralised. If anything fails the
   * half-made worktree is removed again.
   */
  private async addWorktree(repo: string, worktreePath: string, addArgs: string[]): Promise<void> {
    await this.git(repo, addArgs);
    try {
      // Listed from the new worktree itself: conditional includes (includeIf onbranch/gitdir)
      // resolve here exactly as they will during the checkout below.
      const overrides = await this.neutralisedFilters(worktreePath);
      await this.git(worktreePath, ["reset", "--hard", "--quiet", "HEAD"], overrides);
    } catch (err) {
      await this.git(repo, ["worktree", "remove", "--force", "--", worktreePath]).catch(
        () => undefined,
      );
      throw err;
    }
  }

  /**
   * Config overrides that disable every filter driver configured for `cwd`. A smudge or process
   * filter is a command git runs while checking files out, so an untrusted repository could
   * otherwise execute code on the host while its worktree is created. `required=false` makes git
   * carry on with the unfiltered content (for example git-lfs pointer files).
   *
   * The listing uses --null, which separates key from value unambiguously (a value can contain
   * anything, including text that looks like another variable). It fails closed: only "exit 1 and
   * no stderr" (nothing matched) means there are no filters; any other failure aborts creation.
   */
  private async neutralisedFilters(cwd: string): Promise<[string, string][]> {
    let listing: string;
    try {
      listing = await this.git(cwd, [
        "config",
        "--null",
        "--get-regexp",
        "^filter\\..+\\.(smudge|clean|process)$",
      ]);
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1 && err.stderr.trim() === "") return [];
      throw err;
    }
    const drivers = new Set<string>();
    for (const record of listing.split("\0")) {
      const key = record.split("\n", 1)[0] ?? "";
      const name = /^filter\.(.+)\.(?:smudge|clean|process)$/.exec(key)?.[1];
      if (name) drivers.add(name);
    }
    if (drivers.size > 100) throw new GitError(`refusing ${drivers.size} filter drivers`, "");
    return [...drivers].flatMap((d): [string, string][] => [
      [`filter.${d}.smudge`, "false"],
      [`filter.${d}.clean`, "false"],
      [`filter.${d}.process`, "false"],
      [`filter.${d}.required`, "false"],
    ]);
  }

  /** Inside a root once symlinks are resolved. */
  private allowed(p: string): boolean {
    return this.roots.some((root) => inside(p, root));
  }

  /** The path as written is inside a root, or inside a root as the caller named it. */
  private allowedLexically(p: string): boolean {
    return this.allowed(p) || this.lexicalRoots.some((root) => inside(p, root));
  }

  // --- git -----------------------------------------------------------------------------------

  private exclusive<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.queues.set(
      repo,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Runs git with a fixed environment: the server's GIT_DIR, GIT_WORK_TREE and similar variables
   * must not redirect it, and the repository's own hooks are switched off (core.hooksPath), because
   * a worktree is created by the stack, not by the repository's owner.
   */
  private async git(cwd: string, args: string[], config: [string, string][] = []): Promise<string> {
    // Overrides go through GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n so key and value can never be
    // confused with each other (a `-c key=value` string splits at the first '=').
    const entries: [string, string][] = [
      ["core.hooksPath", "/dev/null"],
      ["core.fsmonitor", "false"],
      ...config,
    ];
    const configEnv: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
    entries.forEach(([key, value], i) => {
      configEnv[`GIT_CONFIG_KEY_${i}`] = key;
      configEnv[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    try {
      const { stdout } = await run("git", ["-C", cwd, ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          LANG: process.env.LANG ?? "C",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          ...configEnv,
        },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string; code?: unknown };
      throw new GitError(
        `git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`,
        e.stderr ?? "",
        typeof e.code === "number" ? e.code : undefined,
      );
    }
  }

  private async gitOk(cwd: string, args: string[]): Promise<boolean> {
    try {
      await this.git(cwd, args);
      return true;
    } catch {
      return false;
    }
  }
}
