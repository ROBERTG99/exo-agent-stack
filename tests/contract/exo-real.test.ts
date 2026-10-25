// @real-exo: host-only. Records the scenario against a running Exo (EXOS_EXO_URL, for example
// http://127.0.0.1:9810/exo, with the agent catalogue synced and its harness answering from the
// fake model) and requires the shapes to match the committed recordings. Run with `make test-exo`.
// Skipped, with the reason printed, when no Exo is configured.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareDirs, recordScenario, writeRecordings } from "../../scripts/record-exo.ts";

const url = process.env.EXOS_EXO_URL;
if (!url) console.log("[@real-exo] skipped: EXOS_EXO_URL is not set (no real Exo to record from)");

describe.skipIf(!url)("@real-exo shapes", () => {
  it("match the committed exo-sim recordings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-host-"));
    try {
      writeRecordings(dir, await recordScenario({ baseUrl: url!, source: "exo-host" }));
      const { failures, notes } = compareDirs(
        join(import.meta.dirname, "../../fixtures/exo-recordings/exo-sim"),
        dir,
      );
      for (const n of notes) console.log(`[@real-exo] note: ${n}`);
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
