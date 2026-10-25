// Is a shell command one a person need not look at twice? This decides which `claude.Bash`
// approvals the bridge may settle (BUILD.md §15.3, FR-11): everything that is not provably simple
// and local is dashboard-only. It fails closed. A blacklist of dangerous phrases cannot work here
// (`git -c x=y push`, `/usr/bin/git  push`, `python -c ...` all get past one), so instead the command
// is parsed into plain words, and only a short list of programs with safe arguments passes. Anything
// the parser does not fully understand (substitution, subshells, here-documents, variables, odd
// quoting of the program name) is refused. This is a convenience limit on who approves, one layer in
// front of the deny rules and the path guard, not a sandbox.

const MAX_LENGTH = 4_000;

interface Word {
  text: string;
  /** Written with quotes or backslashes (so `g""it` is not mistaken for `git`). */
  decorated: boolean;
  /** Has an unquoted `*`, `?` or `[`: the shell will replace it with matching file names. */
  glob?: boolean;
}

interface Segment {
  words: Word[];
}

const BIN_DIRS = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]);
/** Nothing may be written to a file: a later command could run it. Only the bit bucket is allowed. */
const SAFE_REDIRECT_TARGET = (t: string): boolean => t === "/dev/null";

/** A relative path that stays inside the working directory and uses no expansion. */
function isLocalPath(p: string): boolean {
  return (
    p !== "" &&
    !p.startsWith("/") &&
    !p.startsWith("~") &&
    !/(^|\/)\.\.(\/|$)/.test(p) &&
    !/[$`]/.test(p)
  );
}

/** Splits into segments of words, or null if anything is not understood. */
function parse(command: string): Segment[] | null {
  if (command.length === 0 || command.length > MAX_LENGTH) return null;
  const segments: Segment[] = [];
  let words: Word[] = [];
  let current: Word | null = null;
  let pendingRedirect = false;
  let i = 0;

  const endWord = () => {
    if (!current) return;
    // `.*` and `.[a-z]*` also match `..`, which leaves the working directory
    if (current.glob && current.text.split("/").some((segment) => segment.startsWith(".")))
      throw new Fail();
    if (pendingRedirect) {
      if (!SAFE_REDIRECT_TARGET(current.text)) throw new Fail();
      pendingRedirect = false;
    } else {
      words.push(current);
    }
    current = null;
  };
  const endSegment = () => {
    endWord();
    if (pendingRedirect || words.length === 0) throw new Fail();
    segments.push({ words });
    words = [];
  };
  const add = (ch: string, decorated = false) => {
    // brace expansion can build any path out of a word that looks local (`{..,x}/y`)
    if (!decorated && (ch === "{" || ch === "}")) throw new Fail();
    current ??= { text: "", decorated: false };
    if (!decorated && (ch === "*" || ch === "?" || ch === "[")) current.glob = true;
    current.text += ch;
    if (decorated) current.decorated = true;
  };

  try {
    while (i < command.length) {
      const ch = command[i]!;
      const code = ch.charCodeAt(0);
      if ((code < 32 && ch !== "\n" && ch !== "\t") || code === 127) throw new Fail();

      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) throw new Fail();
        current ??= { text: "", decorated: false };
        current.decorated = true;
        current.text += command.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        current ??= { text: "", decorated: false };
        current.decorated = true;
        i++;
        for (;;) {
          if (i >= command.length) throw new Fail();
          const c = command[i]!;
          if (c === '"') break;
          if (c === "$" || c === "`") throw new Fail();
          if (c === "\\") {
            if (i + 1 >= command.length) throw new Fail();
            current.text += command[i + 1];
            i += 2;
            continue;
          }
          current.text += c;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 >= command.length || command[i + 1] === "\n") throw new Fail();
        add(command[i + 1]!, true);
        i += 2;
        continue;
      }
      if (ch === "$" || ch === "`" || ch === "(" || ch === ")") throw new Fail();

      if (ch === " " || ch === "\t") {
        endWord();
        i++;
        continue;
      }
      if (ch === "\n" || ch === ";") {
        endSegment();
        i++;
        continue;
      }
      if (ch === "|") {
        if (command[i + 1] === "&") throw new Fail();
        endSegment();
        i += command[i + 1] === "|" ? 2 : 1;
        continue;
      }
      if (ch === "&") {
        if (command[i + 1] === "&") {
          endSegment();
          i += 2;
          continue;
        }
        if (command[i + 1] !== ">") throw new Fail(); // background job
        // &> and &>>: both streams to a file
        if (current) throw new Fail();
        i += command[i + 2] === ">" ? 3 : 2;
        endWord();
        pendingRedirect = true;
        continue;
      }
      if (ch === ">" || ch === "<") {
        if (command[i + 1] === "<") throw new Fail(); // here-document or here-string
        // a leading file descriptor number belongs to the operator
        if (current && /^\d+$/.test(current.text) && !current.decorated) current = null;
        else endWord();
        i++;
        if (ch === ">" && command[i] === ">") i++;
        if (command[i] === "&") {
          // fd duplication: >&2, 2>&1, >&-
          const m = /^&(\d+|-)/.exec(command.slice(i));
          if (!m) throw new Fail();
          i += m[0].length;
          continue;
        }
        if (command[i] === "|" || command[i] === "(") throw new Fail();
        pendingRedirect = true;
        continue;
      }
      add(ch);
      i++;
    }
    endSegment();
  } catch (err) {
    if (err instanceof Fail) return null;
    throw err;
  }
  return segments;
}

class Fail extends Error {}

// --- what each program may do --------------------------------------------------------------------
//
// Only read-only inspection is vouched for: nothing that writes a file (a later command might run
// it), runs code from the repository, or reaches the network. Flags come from a short list per
// program; a flag that is not listed makes the command unsafe. Paths must be relative and stay in
// the working directory, so a bridge-approved `cat` cannot print a token file. (A symlink inside the
// worktree that points elsewhere is not visible to a string check; the deny rules and the path
// guard remain the defence there.)

type ValueKind = "num" | "text" | "glob";

interface Spec {
  /** Letters usable alone or bundled (`-rn`). */
  short?: string;
  /** Letters that take a value, attached (`-n5`) or as the next word; last in a bundle. */
  valueShort?: Record<string, ValueKind>;
  long?: string[];
  valueLong?: Record<string, ValueKind>;
  /** How many leading positional words are free text (a pattern) rather than paths. */
  text?: (seen: Set<string>) => number;
  /** At most this many positional words. */
  max?: number;
  /** Positional words are paths and must stay local (default true). */
  paths?: boolean;
}

const DIGITS = "0123456789";

function valueOk(kind: ValueKind, v: string): boolean {
  if (kind === "num") return /^\d{1,9}$/.test(v);
  if (kind === "glob")
    return /^[A-Za-z0-9_.*?/[\]{},+-]{1,200}$/.test(v) && isLocalPath(v.replace(/^\*+\/?/, "x"));
  return v.length <= 500 && ![...v].some((c) => c.charCodeAt(0) < 32 && c !== "\t");
}

/**
 * Checks `args` against a spec; returns the positional words, or null if anything is off. `globs[i]`
 * says that `args[i]` has an unquoted pattern: the shell replaces it with file names, and one named
 * `--pre=sh` or `-ofoo` would then be read as an option. A pattern is therefore only accepted as a
 * path after an explicit `--`.
 */
function check(spec: Spec, args: string[], globs: boolean[]): string[] | null {
  const seen = new Set<string>();
  const positional: string[] = [];
  let i = 0;
  let endOfOptions = false;
  while (i < args.length) {
    const at = i++;
    const a = args[at]!;
    if (globs[at] && !endOfOptions) return null;
    if (!endOfOptions && a === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (eq < 0 && spec.long?.includes(name)) {
        seen.add(name);
        continue;
      }
      const kind = spec.valueLong?.[name];
      if (!kind) return null;
      if (eq < 0 && globs[i]) return null;
      const value = eq < 0 ? args[i++] : a.slice(eq + 1);
      if (value === undefined || !valueOk(kind, value)) return null;
      seen.add(name);
      continue;
    }
    if (!endOfOptions && a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (spec.short?.includes(c)) {
          seen.add(c);
          continue;
        }
        const kind = spec.valueShort?.[c];
        if (!kind) return null;
        const attached = a.slice(j + 1);
        if (attached === "" && globs[i]) return null;
        const value = attached !== "" ? attached : args[i++];
        if (value === undefined || !valueOk(kind, value)) return null;
        seen.add(c);
        break;
      }
      continue;
    }
    positional.push(a);
  }
  if (spec.max !== undefined && positional.length > spec.max) return null;
  const free = spec.text?.(seen) ?? 0;
  if (positional.length < free) return null;
  const pathWords = positional.slice(free);
  if ((spec.paths ?? true) && !pathWords.every(isLocalPath)) return null;
  return positional;
}

const NONE: Spec = { max: 0 };

const SPECS: Record<string, Spec> = {
  ls: { short: "lahAR1tSrdFpGs" },
  cat: { short: "nbsAETv" },
  head: {
    short: DIGITS,
    valueShort: { n: "num", c: "num" },
    valueLong: { "--lines": "num", "--bytes": "num" },
  },
  tail: {
    short: DIGITS,
    valueShort: { n: "num", c: "num" },
    valueLong: { "--lines": "num", "--bytes": "num" },
  },
  wc: { short: "lwcmL" },
  pwd: NONE,
  true: NONE,
  false: NONE,
  realpath: { max: 4 },
  grep: grepSpec(),
  egrep: grepSpec(),
  fgrep: grepSpec(),
  rg: {
    short: "nivclLwFsSoI",
    valueShort: { e: "text", g: "glob", t: "text", m: "num", A: "num", B: "num", C: "num" },
    long: [
      "--line-number",
      "--ignore-case",
      "--invert-match",
      "--count",
      "--files-with-matches",
      "--word-regexp",
      "--fixed-strings",
      "--only-matching",
      "--hidden",
    ],
    valueLong: { "--glob": "glob", "--type": "text", "--max-count": "num", "--regexp": "text" },
    text: (seen) => (seen.has("e") || seen.has("--regexp") ? 0 : 1),
  },
  diff: {
    short: "uqrNiwBb",
    valueShort: { U: "num" },
    long: ["--unified", "--brief", "--recursive", "--ignore-case", "--ignore-all-space"],
    max: 2,
  },
  sort: {
    short: "nrufbdhmMVsc",
    valueShort: { k: "text", t: "text" },
    long: [
      "--numeric-sort",
      "--reverse",
      "--unique",
      "--ignore-case",
      "--version-sort",
      "--human-numeric-sort",
      "--stable",
      "--ignore-leading-blanks",
      "--dictionary-order",
      "--month-sort",
    ],
    valueLong: { "--key": "text", "--field-separator": "text" },
  },
  uniq: { short: "cdui", valueShort: { f: "num", s: "num", w: "num" }, max: 1 },
  cut: { short: "s", valueShort: { d: "text", f: "text", c: "text", b: "text" } },
  tr: { short: "dsc", paths: false, text: () => 0 },
  basename: { paths: false, max: 2 },
  dirname: { paths: false, max: 1 },
  which: { paths: false, max: 4 },
};

function grepSpec(): Spec {
  return {
    short: "rnivclLwxFEhHsqIaoz",
    valueShort: { e: "text", m: "num", A: "num", B: "num", C: "num" },
    long: [
      "--recursive",
      "--line-number",
      "--ignore-case",
      "--invert-match",
      "--count",
      "--files-with-matches",
      "--word-regexp",
      "--no-filename",
      "--with-filename",
      "--only-matching",
      "--quiet",
    ],
    valueLong: {
      "--include": "glob",
      "--exclude": "glob",
      "--exclude-dir": "glob",
      "--max-count": "num",
      "--context": "num",
      "--regexp": "text",
    },
    text: (seen) => (seen.has("e") || seen.has("--regexp") ? 0 : 1),
  };
}

/** `find`: start points, then a short list of read-only tests. */
function findIsSafe(args: string[], globs: boolean[]): boolean {
  if (globs.some(Boolean)) return false;
  let i = 0;
  while (i < args.length && !args[i]!.startsWith("-") && args[i] !== "!") {
    if (!isLocalPath(args[i]!)) return false;
    i++;
  }
  const withValue: Record<string, ValueKind> = {
    "-name": "glob",
    "-iname": "glob",
    "-path": "glob",
    "-ipath": "glob",
    "-type": "text",
    "-maxdepth": "num",
    "-mindepth": "num",
    "-size": "text",
    "-mtime": "text",
    "-perm": "text",
  };
  const bare = new Set([
    "-print",
    "-print0",
    "-empty",
    "-not",
    "!",
    "-a",
    "-o",
    "-and",
    "-or",
    "-readable",
    "-writable",
  ]);
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (bare.has(a)) continue;
    const kind = withValue[a];
    if (!kind) return false;
    const v = args[++i];
    if (v === undefined) return false;
    if (kind === "text" ? !/^[A-Za-z0-9+_.,-]{1,40}$/.test(v) : !valueOk(kind, v)) return false;
  }
  return true;
}

// git runs programs named in the repository's own config (signature checking through `gpg.program`,
// clean and textconv filters, `diff.external`, the file system monitor), and an agent may have written
// that file. So only commands that read objects and refs are vouched for (`status` and `diff` of the
// work tree run clean filters and the monitor; `blame`, `shortlog`, `describe` and `ls-files` are left
// to the dashboard), and each has to switch the rest off itself: `--no-pager` and `-c
// log.showSignature=false` before the subcommand, and `--no-ext-diff --no-textconv` for `log` and
// `show`. A `-c` on the command line outranks every config file.
const GIT_READ_ONLY = new Set(["log", "show", "rev-parse"]);
const GIT_DIFFS = new Set(["log", "show"]);
/** Options that write a file, run a program or point git somewhere else (long ones, whole). */
const GIT_FORBIDDEN_LONG = [
  "--output",
  "--ext-diff",
  "--textconv",
  "--open-files-in-pager",
  "--no-index",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--contents",
  "--show-signature",
];

function gitIsSafe(args: string[], globs: boolean[]): boolean {
  let k = 0;
  let noPager = false;
  let signatureOff = false;
  for (;;) {
    if (args[k] === "--no-pager") {
      noPager = true;
      k += 1;
    } else if (args[k] === "-c" && args[k + 1] === "log.showSignature=false") {
      signatureOff = true;
      k += 2;
    } else break;
  }
  if (!noPager || !signatureOff || globs.slice(0, k + 1).some(Boolean)) return false;
  const sub = args[k++];
  if (sub === undefined || !GIT_READ_ONLY.has(sub)) return false;
  const needed = new Set(GIT_DIFFS.has(sub) ? ["--no-ext-diff", "--no-textconv"] : []);
  let endOfOptions = false;
  for (; k < args.length; k++) {
    const a = args[k]!;
    if (globs[k] && !endOfOptions) return false;
    if (!endOfOptions && a === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith("-")) {
      needed.delete(a);
      // git accepts any unambiguous abbreviation of a long option (`--ext` for `--ext-diff`)
      const name = a.split("=")[0]!;
      if (
        /^-O/.test(a) ||
        (name.startsWith("--") && GIT_FORBIDDEN_LONG.some((f) => f.startsWith(name))) ||
        !/^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(=[A-Za-z0-9_.,:/@~^-]*)?$/.test(a)
      )
        return false;
      continue;
    }
    // a revision or a path: no leading slash or tilde, no ".." path segment, no expansion
    if (!isLocalPath(a)) return false;
  }
  return needed.size === 0;
}

function programOf(word: Word): string | null {
  if (word.decorated) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) return null; // an assignment before the command
  if (!word.text.includes("/")) return word.text;
  const slash = word.text.lastIndexOf("/");
  return BIN_DIRS.has(word.text.slice(0, slash)) ? word.text.slice(slash + 1) : null;
}

function segmentIsSafe(segment: Segment): boolean {
  const [first, ...rest] = segment.words;
  const program = programOf(first!);
  if (!program) return false;
  const args = rest.map((w) => w.text);
  const globs = rest.map((w) => w.glob === true);
  if (first!.glob) return false;

  switch (program) {
    case "echo":
      return !globs.some(Boolean);
    case "printf":
      // options before the format (`-v var` assigns a shell variable) are not needed
      return !globs.some(Boolean) && !args[0]?.startsWith("-");
    case "date":
      return (
        args.length === 0 || (args.length === 1 && /^\+[A-Za-z0-9%:_ .-]{1,60}$/.test(args[0]!))
      );
    case "cd":
      return args.length === 1 && !globs[0] && isLocalPath(args[0]!);
    case "find":
      return findIsSafe(args, globs);
    case "git":
      return gitIsSafe(args, globs);
    default: {
      const spec = Object.hasOwn(SPECS, program) ? SPECS[program] : undefined;
      return spec !== undefined && check(spec, args, globs) !== null;
    }
  }
}

export function isProvablySafeBash(command: string): boolean {
  const segments = parse(command);
  return segments !== null && segments.every(segmentIsSafe);
}
