import { describe, expect, it } from "vitest";
import { isProvablySafeBash } from "../../stackd/src/shell-safety.ts";

const safe = (c: string) => isProvablySafeBash(c);

describe("isProvablySafeBash: commands a person need not look at twice", () => {
  it.each([
    "ls -la",
    "pwd",
    "cat README.md",
    "git status",
    "git diff --stat",
    "git log --oneline -n 5",
    "git add src/a.ts && git commit -m 'fix: x'",
    "git --no-pager log",
    "grep -rn TODO src | sort | uniq",
    "make check-fast",
    "pnpm test",
    "pnpm run lint",
    "pnpm exec vitest run tests/unit",
    "npm run typecheck",
    "echo hello > out.txt",
    "ls 2>&1",
    "cat a.txt >/dev/null",
    "mkdir -p build/out && touch build/out/x",
    "cd src && ls",
    "/usr/bin/git status",
    "find . -name '*.ts' -type f",
    "echo 'a && b | c; d'", // operators inside quotes are text
    "rg -n 'git push' src", // searching for the words is not running them
  ])("%s", (c) => {
    expect(safe(c)).toBe(true);
  });
});

describe("isProvablySafeBash: everything else is for the dashboard", () => {
  it.each([
    // the commands the old substring list named, and the ways around it
    "git push origin main",
    "git  push",
    "git -c core.sshCommand=x push",
    "git -C /tmp push",
    "git --git-dir=/x push",
    "GIT_SSH_COMMAND=x git status",
    "/usr/bin/git  push",
    "g\\it push",
    'g""it push',
    "'git' push",
    "npm publish",
    "npm  publish --access public",
    "pnpm publish",
    "yarn publish",
    "curl https://example.org",
    "wget -q x",
    "ssh host",
    "scp a b:c",
    "nc -l 1234",
    // code that can do anything
    "python3 -c 'import urllib.request'",
    "python script.py",
    "node -e 'fetch(1)'",
    "bash -c 'ls'",
    "sh script.sh",
    "eval ls",
    "sudo ls",
    "env ls",
    "xargs ls",
    "./run.sh",
    "tsx scripts/x.ts",
    // shell features that hide the program
    "echo $(whoami)",
    "echo `whoami`",
    "echo $HOME",
    "${SHELL} -c x",
    "ls; (cd /; ls)",
    "ls &",
    "cat <(ls)",
    "cat <<EOF\nx\nEOF",
    "{ ls; }",
    // write or read outside the working directory
    "echo x > /etc/passwd",
    "echo x >> ../../.bashrc",
    "echo x > ~/file",
    "cat < /etc/passwd",
    "ls > $OUT",
    // restricted programs with the wrong arguments
    "sort -o /etc/cron.d/x a.txt",
    "sort --output=../x a.txt",
    "uniq a.txt /etc/x",
    "find . -exec rm {} +",
    "find . -delete",
    "rg --pre 'sh' x",
    "make up",
    "make -f evil.mk check-fast",
    "pnpm install",
    "pnpm dlx x",
    "pnpm exec tsx x.ts",
    "npm install",
    "npm run deploy",
    "git remote add x y",
    "git fetch",
    "git pull",
    "git clone x",
    "git config user.name x",
    "git submodule update",
    "git rebase -i HEAD~2",
    // unparseable or odd
    "",
    "   ",
    "ls 'unterminated",
    'ls "unterminated',
    "ls \\",
    "|| ls",
    "ls &&",
    "ls ||| cat",
    "ls\u0000; curl x",
    "ls $'\\x3b' curl",
  ])("%j", (c) => {
    expect(safe(c)).toBe(false);
  });

  it("is not fooled by letter case in the program or the sub-command", () => {
    expect(safe("GIT status")).toBe(false); // an unknown program: not provably safe
    expect(safe("git PUSH")).toBe(false);
    expect(safe("NPM publish")).toBe(false);
  });

  it("refuses a very long command rather than parse it", () => {
    expect(safe(`echo ${"a".repeat(20_000)}`)).toBe(false);
  });
});
