// `exos dual-review compare`: compare two code reviews of the same target (BUILD.md FR-6).
// A review is a Markdown report with bullet findings, or JSON lines, as saved by the `write_report`
// tool of a claude-host thread and a cursor thread. The result is `dual-review.comparison.v1`.
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { CommandIo } from "../main.ts";

export interface Finding {
  file: string;
  line: number;
  category: string;
  summary: string;
}

export interface ParsedFindings {
  findings: Finding[];
  warnings: string[];
}

const BULLET =
  /^\s*(?:[-*]|\d+\.)\s*\[([A-Za-z][A-Za-z-]*)\]\s+([^\s:]+):(\d+)(?:-\d+)?\s*[-–:]?\s*(.*?)\s*$/;

const normalizeFile = (f: string): string => f.replace(/^(?:\.\/)+/, "").replace(/^[ab]\//, "");

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((x) => {
    const key = `${x.file}\0${x.line}\0${x.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Reads findings from a Markdown report (bullets) or JSON lines. Unusable data-like lines become warnings. */
export function parseFindings(text: string): ParsedFindings {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const at = `line ${index + 1}`;
    if (line.startsWith("{")) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const lineNo = Number(o.line);
        if (
          typeof o.file !== "string" ||
          typeof o.category !== "string" ||
          !Number.isInteger(lineNo) ||
          lineNo < 1
        ) {
          throw new Error("missing file, category or line");
        }
        findings.push({
          file: normalizeFile(o.file),
          line: lineNo,
          category: o.category.toLowerCase(),
          summary: typeof o.summary === "string" ? o.summary.trim() : "",
        });
      } catch (err) {
        warnings.push(
          `${at}: ignored a finding that could not be read (${(err as Error).message})`,
        );
      }
      return;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      findings.push({
        file: normalizeFile(bullet[2]!),
        line: Number(bullet[3]),
        category: bullet[1]!.toLowerCase(),
        summary: bullet[4]!,
      });
    } else if (line.endsWith("{") || line.endsWith("}")) {
      // Prose never ends in a brace; this is most likely a truncated or damaged JSON export.
      warnings.push(`${at}: ignored a line that looks like data but is not a finding`);
    }
  });
  return { findings: dedupe(findings), warnings };
}

const byLocation = (a: Finding, b: Finding): number =>
  a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : a.line - b.line || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0);

export interface Side {
  label: string;
  findings: Finding[];
}

const findingSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  category: z.string(),
  summary: z.string(),
});
const sideSchema = z.object({
  label: z.string(),
  count: z.number().int(),
  findings: z.array(findingSchema),
});

export const comparisonSchema = z.object({
  schema: z.literal("dual-review.comparison.v1"),
  sides: z.object({ a: sideSchema, b: sideSchema }),
  overlap: z.array(
    z.object({ a: findingSchema, b: findingSchema, match: z.enum(["exact", "near"]) }),
  ),
  only_a: z.array(findingSchema),
  only_b: z.array(findingSchema),
  summary: z.object({
    a: z.number().int(),
    b: z.number().int(),
    overlap: z.number().int(),
    only_a: z.number().int(),
    only_b: z.number().int(),
    jaccard: z.number(),
    tolerance: z.number().int(),
  }),
});

export type Comparison = z.infer<typeof comparisonSchema>;

/**
 * Two findings agree when they name the same file and category and their lines are at most
 * `tolerance` apart. Matching is one-to-one, closest lines first, so the result does not depend on
 * the order of the inputs.
 */
export function compareReviews(a: Side, b: Side, opts: { tolerance?: number } = {}): Comparison {
  const tolerance = opts.tolerance ?? 3;
  const as = [...dedupe(a.findings)].sort(byLocation);
  const bs = [...dedupe(b.findings)].sort(byLocation);

  const candidates: { i: number; j: number; distance: number }[] = [];
  as.forEach((x, i) =>
    bs.forEach((y, j) => {
      if (
        x.file === y.file &&
        x.category === y.category &&
        Math.abs(x.line - y.line) <= tolerance
      ) {
        candidates.push({ i, j, distance: Math.abs(x.line - y.line) });
      }
    }),
  );
  candidates.sort((p, q) => p.distance - q.distance || p.i - q.i || p.j - q.j);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const overlap: Comparison["overlap"] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    overlap.push({ a: as[c.i]!, b: bs[c.j]!, match: c.distance === 0 ? "exact" : "near" });
  }
  overlap.sort((p, q) => byLocation(p.a, q.a));

  const onlyA = as.filter((_, i) => !usedA.has(i));
  const onlyB = bs.filter((_, j) => !usedB.has(j));
  const union = as.length + bs.length - overlap.length;
  return {
    schema: "dual-review.comparison.v1",
    sides: {
      a: { label: a.label, count: as.length, findings: as },
      b: { label: b.label, count: bs.length, findings: bs },
    },
    overlap,
    only_a: onlyA,
    only_b: onlyB,
    summary: {
      a: as.length,
      b: bs.length,
      overlap: overlap.length,
      only_a: onlyA.length,
      only_b: onlyB.length,
      jaccard: union === 0 ? 1 : Math.round((overlap.length / union) * 10000) / 10000,
      tolerance,
    },
  };
}

const USAGE =
  "usage: exos dual-review compare --a <review> --b <review> [--label-a NAME] [--label-b NAME] [--tolerance N] [--out FILE]";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function dualReviewCommand(args: string[], io: CommandIo): number {
  if (args[0] !== "compare") {
    io.err(USAGE);
    return 2;
  }
  const pathA = option(args, "--a");
  const pathB = option(args, "--b");
  if (!pathA || !pathB) {
    io.err(USAGE);
    return 2;
  }
  const toleranceArg = option(args, "--tolerance");
  const tolerance = toleranceArg === undefined ? 3 : Number(toleranceArg);
  if (!Number.isInteger(tolerance) || tolerance < 0) {
    io.err(`invalid --tolerance ${JSON.stringify(toleranceArg)}: expected a whole number of lines`);
    return 2;
  }

  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      io.err(`cannot read ${path}: file not found or unreadable`);
      return null;
    }
  };
  const textA = read(pathA);
  const textB = read(pathB);
  if (textA === null || textB === null) return 2;

  const parsedA = parseFindings(textA);
  const parsedB = parseFindings(textB);
  for (const w of parsedA.warnings) io.err(`${pathA}: ${w}`);
  for (const w of parsedB.warnings) io.err(`${pathB}: ${w}`);

  const comparison = compareReviews(
    { label: option(args, "--label-a") ?? "a", findings: parsedA.findings },
    { label: option(args, "--label-b") ?? "b", findings: parsedB.findings },
    { tolerance },
  );
  const out = option(args, "--out");
  if (out) {
    writeFileSync(out, `${JSON.stringify(comparison, null, 2)}\n`);
    const s = comparison.summary;
    io.out(
      `overlap ${s.overlap} of ${s.a} and ${s.b} findings (jaccard ${s.jaccard}); wrote ${out}`,
    );
  } else {
    io.out(JSON.stringify(comparison, null, 2));
  }
  return 0;
}
