import { caseId, splitCases, type Rng } from "../prng.ts";

/** 30 cases (10 dev / 20 test): kill Exo at a seeded step, optionally drop the client or restart stackd. */
export function durabilitySuite(rng: Rng) {
  const cases = [];
  for (let i = 0; i < 30; i++) {
    // The first case is the headline requirement (FR-10): 12 steps, SIGKILL at step 6.
    const headline = i === 0;
    const total = headline ? 12 : rng.int(8, 16);
    const kill = headline ? 6 : rng.int(2, total - 2);
    const mode = i % 4; // all four failure modes appear
    cases.push({
      id: caseId("dur", i + 1),
      suite: "durability",
      scenario: `steps${total}`,
      total_steps: total,
      kill_at_step: kill,
      drop_client: mode === 1 || mode === 3,
      restart_stackd: mode === 2 || mode === 3,
      seed: rng.int(1, 2 ** 31 - 1),
      expect: { completed: true, duplicates: 0, unique_ledger_entries: total },
    });
  }
  return splitCases(rng, cases, 10);
}
