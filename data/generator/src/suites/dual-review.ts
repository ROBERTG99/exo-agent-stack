import { caseId, splitCases, type Rng } from "../prng.ts";

interface Template {
  category: "correctness" | "security" | "error-handling" | "concurrency";
  file: string;
  /** Lines of the file after the change; `bug` is the 1-based index of the defective line. */
  build: (name: string) => { before: string[]; after: string[]; bug: number };
  title: string;
}

const NAMES = ["Orders", "Invoices", "Reports", "Sessions", "Tickets", "Catalog"];

const TEMPLATES: Template[] = [
  {
    category: "correctness",
    file: "src/paginate.ts",
    title: "loop bound reads one past the end",
    build: (n) => ({
      before: [
        `export function sum${n}(items: number[]): number {`,
        "  let total = 0;",
        "  for (let i = 0; i < items.length; i++) {",
        "    total += items[i]!;",
        "  }",
        "  return total;",
        "}",
      ],
      after: [
        `export function sum${n}(items: number[]): number {`,
        "  let total = 0;",
        "  for (let i = 0; i <= items.length; i++) {",
        "    total += items[i]!;",
        "  }",
        "  return total;",
        "}",
      ],
      bug: 3,
    }),
  },
  {
    category: "security",
    file: "src/db.ts",
    title: "SQL built by string concatenation",
    build: (n) => ({
      before: [
        `export function find${n}(db: Db, id: string) {`,
        `  return db.query("SELECT * FROM ${n.toLowerCase()} WHERE id = ?", [id]);`,
        "}",
      ],
      after: [
        `export function find${n}(db: Db, id: string) {`,
        `  return db.query("SELECT * FROM ${n.toLowerCase()} WHERE id = '" + id + "'");`,
        "}",
      ],
      bug: 2,
    }),
  },
  {
    category: "error-handling",
    file: "src/client.ts",
    title: "error swallowed, caller sees success",
    build: (n) => ({
      before: [
        `export async function push${n}(api: Api, payload: unknown) {`,
        "  const res = await api.post(payload);",
        "  if (!res.ok) throw new Error(`push failed: ${res.status}`);",
        "  return res.json();",
        "}",
      ],
      after: [
        `export async function push${n}(api: Api, payload: unknown) {`,
        "  try {",
        "    const res = await api.post(payload);",
        "    return res.json();",
        "  } catch {}",
        "}",
      ],
      bug: 5,
    }),
  },
  {
    category: "concurrency",
    file: "src/counter.ts",
    title: "read-modify-write across an await",
    build: (n) => ({
      before: [
        `let next${n} = 0;`,
        `export function allocate${n}(): number {`,
        `  return next${n}++;`,
        "}",
      ],
      after: [
        `let next${n} = 0;`,
        `export async function allocate${n}(store: Store): Promise<number> {`,
        `  const current = await store.get("next${n}");`,
        `  await store.set("next${n}", current + 1);`,
        "  return current;",
        "}",
      ],
      bug: 4,
    }),
  },
  {
    category: "security",
    file: "src/auth.ts",
    title: "secret compared with a non-constant-time operator",
    build: (n) => ({
      before: [
        `export function check${n}(token: string, expected: string): boolean {`,
        "  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));",
        "}",
      ],
      after: [
        `export function check${n}(token: string, expected: string): boolean {`,
        "  return token === expected;",
        "}",
      ],
      bug: 2,
    }),
  },
];

function unifiedDiff(file: string, before: string[], after: string[]): string {
  const header = [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${before.length} +1,${after.length} @@`];
  // A plain replacement hunk keeps the format trivial and unambiguous for a reviewer.
  const body = [...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)];
  return [...header, ...body].join("\n") + "\n";
}

/** 10 synthetic diffs (3 dev / 7 test): five defect patterns, two variants each. */
export function dualReviewSuite(rng: Rng) {
  const cases = [];
  let n = 0;
  for (const t of TEMPLATES) {
    for (const name of rng.shuffle(NAMES).slice(0, 2)) {
      const { before, after, bug } = t.build(name);
      cases.push({
        id: caseId("rev", ++n),
        suite: "dual-review",
        title: t.title,
        diff: unifiedDiff(t.file, before, after),
        gold_findings: [{ file: t.file, line: bug, category: t.category, summary: t.title }],
      });
    }
  }
  return splitCases(rng, cases, 3);
}
