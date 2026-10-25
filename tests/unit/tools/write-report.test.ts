/* eslint-disable @typescript-eslint/no-explicit-any -- JSON schema objects are schemaless in these assertions */
import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_BYTES,
  writeReport,
  writeReportDeclaration,
  type ArtifactStore,
} from "../../../tools/write-report.ts";

/** An artifact store with Exo's versioning: every distinct write of a name is a new version. */
class MemoryStore implements ArtifactStore {
  versions = new Map<string, string[]>();
  byKey = new Map<string, { name: string; version: number }>();
  writes = 0;
  async write(name: string, content: string, key: string) {
    const known = this.byKey.get(key);
    if (known) return known;
    this.writes++;
    const list = this.versions.get(name) ?? [];
    list.push(content);
    this.versions.set(name, list);
    const out = { name, version: list.length };
    this.byKey.set(key, out);
    return out;
  }
}

describe("write_report", () => {
  it("writes a new version for the same name on each call (FR-7)", async () => {
    const store = new MemoryStore();
    const a = await writeReport(store, { name: "summary", content: "# one" }, "call-1");
    const b = await writeReport(store, { name: "summary", content: "# two" }, "call-2");
    expect(a).toEqual({ name: "summary", version: 1 });
    expect(b).toEqual({ name: "summary", version: 2 });
    expect(store.versions.get("summary")).toEqual(["# one", "# two"]);
  });

  it("is idempotent by tool_call_id: a replayed call does not add a version", async () => {
    const store = new MemoryStore();
    const first = await writeReport(store, { name: "summary", content: "# one" }, "call-1");
    const replay = await writeReport(store, { name: "summary", content: "# one" }, "call-1");
    expect(replay).toEqual(first);
    expect(store.writes).toBe(1);
  });

  it("keeps names independent", async () => {
    const store = new MemoryStore();
    await writeReport(store, { name: "a", content: "x" }, "1");
    expect(await writeReport(store, { name: "b", content: "y" }, "2")).toEqual({
      name: "b",
      version: 1,
    });
  });

  it("accepts exactly 1 MB and rejects one byte more", async () => {
    const store = new MemoryStore();
    expect(MAX_REPORT_BYTES).toBe(1024 * 1024);
    await expect(
      writeReport(store, { name: "big", content: "a".repeat(MAX_REPORT_BYTES) }, "1"),
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      writeReport(store, { name: "big", content: "a".repeat(MAX_REPORT_BYTES + 1) }, "2"),
    ).rejects.toThrow(/1 MB|too large/i);
  });

  it("measures bytes, not characters", async () => {
    const store = new MemoryStore();
    const content = "é".repeat(MAX_REPORT_BYTES / 2 + 1); // 2 bytes each
    await expect(writeReport(store, { name: "utf8", content }, "1")).rejects.toThrow(
      /too large|1 MB/i,
    );
  });

  it.each([
    ["an empty name", { name: "", content: "x" }],
    ["a path in the name", { name: "../x", content: "x" }],
    ["a name with spaces", { name: "a b", content: "x" }],
    ["a name over 128 characters", { name: "n".repeat(129), content: "x" }],
    ["non-string content", { name: "a", content: 5 }],
    ["an extra property", { name: "a", content: "x", extra: 1 }],
  ])("rejects %s without touching the store", async (_n, input) => {
    const store = new MemoryStore();
    await expect(writeReport(store, input as never, "1")).rejects.toThrow();
    expect(store.writes).toBe(0);
  });

  it("declares a strict schema", () => {
    const schema = writeReportDeclaration.input_schema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["name", "content"]);
    expect(writeReportDeclaration.name).toBe("write_report");
  });
});
