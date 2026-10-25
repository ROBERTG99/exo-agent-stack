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
}

interface Segment {
  words: Word[];
}

const BIN_DIRS = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]);
const SAFE_REDIRECT_TARGET = (t: string): boolean =>
  t === "/dev/null" || (isLocalPath(t) && !t.startsWith("-"));

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
    current ??= { text: "", decorated: false };
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

/** Programs that read or print and cannot run other code or reach the network. */
const PLAIN = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "grep",
  "egrep",
  "fgrep",
  "diff",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "which",
  "date",
]);
/** Programs that write: their path arguments must stay inside the working directory. */
const WRITERS = new Set(["mkdir", "touch", "cp", "mv"]);

const GIT_LOCAL = new Set([
  "status",
  "diff",
  "log",
  "show",
  "add",
  "commit",
  "branch",
  "checkout",
  "switch",
  "restore",
  "stash",
  "rev-parse",
  "ls-files",
  "blame",
  "merge-base",
  "describe",
  "shortlog",
  "reset",
  "tag",
]);
const MAKE_TARGETS = new Set(["check-fast", "lint", "typecheck", "test", "test-unit"]);
const NODE_SCRIPTS = new Set(["test", "lint", "typecheck", "build"]);
const EXEC_PROGRAMS = new Set(["vitest", "tsc", "eslint", "prettier"]);
const FIND_UNSAFE = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

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

  if (PLAIN.has(program)) return true;
  if (WRITERS.has(program)) return args.filter((a) => !a.startsWith("-")).every(isLocalPath);
  switch (program) {
    case "sort":
      // -o and --output write a file anywhere
      return (
        !args.some((a) => a === "-o" || a.startsWith("-o") || a.startsWith("--output")) &&
        args.filter((a) => !a.startsWith("-")).every(isLocalPath)
      );
    case "uniq":
      // a second file argument is an output file
      return (
        args.filter((a) => !a.startsWith("-")).length <= 1 &&
        args.filter((a) => !a.startsWith("-")).every(isLocalPath)
      );
    case "cd":
      return args.length === 1 && isLocalPath(args[0]!);
    case "find":
      return !args.some((a) => FIND_UNSAFE.has(a));
    case "rg":
      return !args.some(
        (a) => a === "--pre" || a.startsWith("--pre=") || a.startsWith("--hostname-bin"),
      );
    case "git": {
      let k = 0;
      while (args[k] === "--no-pager") k++;
      return args[k] !== undefined && GIT_LOCAL.has(args[k]!);
    }
    case "make":
      return args.length > 0 && args.every((a) => MAKE_TARGETS.has(a));
    case "pnpm":
    case "npm": {
      if (args[0] === "exec" && program === "pnpm") return EXEC_PROGRAMS.has(args[1] ?? "");
      const script = args[0] === "run" ? args[1] : args[0];
      return script !== undefined && NODE_SCRIPTS.has(script);
    }
    default:
      return false;
  }
}

export function isProvablySafeBash(command: string): boolean {
  const segments = parse(command);
  return segments !== null && segments.every(segmentIsSafe);
}
