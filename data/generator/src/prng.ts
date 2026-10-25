// Seeded randomness only (BUILD.md §6: seed 20261022, gen.v1): no wall clock, no unseeded sources.

/** FNV-1a 32-bit hash of a string, used to derive independent streams from one seed. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Independent stream for a labelled purpose, so adding a suite never shifts another suite's data. */
  child(label: string): Rng {
    return new Rng((this.state ^ hash32(label)) >>> 0);
  }

  /** mulberry32: uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.int(0, 15).toString(16);
    return out;
  }
}

export interface Splittable {
  id: string;
}

/** Seeded dev/test split: the first `devCount` of a shuffle are dev; each case is stamped with its split. */
export function splitCases<T extends Splittable>(
  rng: Rng,
  cases: T[],
  devCount: number,
): { dev: (T & { split: "dev" })[]; test: (T & { split: "test" })[] } {
  const shuffled = rng.shuffle(cases);
  const byId = (a: Splittable, b: Splittable) => (a.id < b.id ? -1 : 1);
  return {
    dev: shuffled
      .slice(0, devCount)
      .sort(byId)
      .map((c) => ({ ...c, split: "dev" as const })),
    test: shuffled
      .slice(devCount)
      .sort(byId)
      .map((c) => ({ ...c, split: "test" as const })),
  };
}

export const caseId = (prefix: string, n: number): string =>
  `${prefix}-${String(n).padStart(4, "0")}`;
